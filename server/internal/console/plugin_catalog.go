package console

import (
	"context"
	"errors"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

type PluginDefinition struct {
	Name                 string   `json:"name"`
	Type                 string   `json:"type"`
	Scope                string   `json:"scope"`
	ConsumerConfigurable bool     `json:"consumer_configurable"`
	ConsumerSource       string   `json:"consumer_source"`
	ConsumerSecrets      []string `json:"consumer_secret_fields"`
	RouteSecrets         []string `json:"route_secret_fields"`
}

// Some legacy authentication plugins intentionally share one schema in both contexts.
func pluginDefinition(name string, metadata Object) PluginDefinition {
	route, _ := metadata["schema"].(map[string]any)
	consumer, dedicated := metadata["consumer_schema"].(map[string]any)
	d := PluginDefinition{Name: name, Type: stringValue(metadata["type"]), Scope: stringValue(metadata["scope"]), ConsumerSource: "none"}
	if dedicated {
		d.ConsumerSource = "dedicated"
	} else if name == "wolf-rbac" {
		d.ConsumerSource = "shared"
		consumer = route
	}
	d.ConsumerConfigurable = d.Scope != "global" && (d.ConsumerSource != "none" || d.Type != "auth")
	d.ConsumerSecrets = schemaSecretFields(Object(consumer))
	d.RouteSecrets = schemaSecretFields(Object(route))
	return d
}

func (g *HTTPGateway) PluginCatalog(ctx context.Context) ([]PluginDefinition, error) {
	var metadata map[string]Object
	if err := g.request(ctx, "GET", "/plugins?all=true", nil, &metadata); err != nil {
		return nil, err
	}
	enabled, err := g.Plugins(ctx)
	if err != nil {
		return nil, err
	}
	definitions := []PluginDefinition{}
	for _, name := range enabled {
		if data, exists := metadata[name]; exists {
			definitions = append(definitions, pluginDefinition(name, data))
		}
	}
	sort.Slice(definitions, func(i, j int) bool { return definitions[i].Name < definitions[j].Name })
	return definitions, nil
}

func (g *HTTPGateway) PluginSchemaFor(ctx context.Context, name, scope string) (Object, error) {
	if scope != "consumer" {
		return g.PluginSchema(ctx, name)
	}
	if cached, ok := g.schemas.Load("consumer/" + name); ok {
		return clone(cached.(Object)), nil
	}
	var schema Object
	err := g.request(ctx, "GET", "/plugins/"+url.PathEscape(name)+"?schema_type=consumer", nil, &schema)
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == 400 {
		schema, err = g.PluginSchema(ctx, name)
	}
	if err == nil {
		normalizePluginSchema(schema)
		g.schemas.Store("consumer/"+name, clone(schema))
	}
	return schema, err
}

// Wildcards represent array entries or dynamic map keys; unresolved references are masked as a whole.
func schemaSecretPointers(schema Object) []string {
	fields := map[string]bool{}
	refs := map[string]bool{}
	budget := 8192
	var walk func(Object, string, int)
	walk = func(node Object, path string, depth int) {
		if node == nil || budget < 0 {
			return
		}
		budget--
		if depth > 64 {
			fields[path] = true
			return
		}
		if node["writeOnly"] == true || node["format"] == "password" {
			fields[path] = true
			return
		}
		if ref, ok := node["$ref"].(string); ok {
			var dest any = map[string]any(schema)
			if !strings.HasPrefix(ref, "#/") || refs[ref] {
				fields[path] = true
				return
			}
			for _, part := range strings.Split(ref[2:], "/") {
				obj, _ := dest.(map[string]any)
				dest = obj[strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")]
			}
			target, _ := dest.(map[string]any)
			if target == nil {
				fields[path] = true
				return
			}
			refs[ref] = true
			walk(Object(target), path, depth+1)
			delete(refs, ref)
		}
		props, _ := node["properties"].(map[string]any)
		if encrypted, ok := node["encrypt_fields"].([]any); ok {
			for _, f := range encrypted {
				field := stringValue(f)
				if field == "" {
					continue
				}
				parts := strings.Split(field, ".")
				if _, literal := props[field]; literal {
					parts = []string{field}
				}
				p := path
				for _, part := range parts {
					p += "/" + pointerPart(part)
				}
				fields[p] = true
			}
		}
		for name, v := range props {
			x, _ := v.(map[string]any)
			walk(Object(x), path+"/"+pointerPart(name), depth+1)
		}
		for _, k := range []string{"oneOf", "anyOf", "allOf"} {
			branches, _ := node[k].([]any)
			for _, v := range branches {
				x, _ := v.(map[string]any)
				walk(Object(x), path, depth+1)
			}
		}
		for _, k := range []string{"if", "then", "else"} {
			x, _ := node[k].(map[string]any)
			walk(Object(x), path, depth+1)
		}
		for _, k := range []string{"items", "additionalProperties", "additionalItems", "contains"} {
			x, _ := node[k].(map[string]any)
			walk(Object(x), path+"/*", depth+1)
		}
		for _, k := range []string{"items", "prefixItems"} {
			arr, _ := node[k].([]any)
			for i, v := range arr {
				x, _ := v.(map[string]any)
				walk(Object(x), path+"/"+strconv.Itoa(i), depth+1)
			}
		}
		patterns, _ := node["patternProperties"].(map[string]any)
		for _, v := range patterns {
			x, _ := v.(map[string]any)
			walk(Object(x), path+"/*", depth+1)
		}
	}
	walk(schema, "", 0)
	if budget < 0 {
		return []string{""}
	}
	out := []string{}
	for p := range fields {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}
func schemaSecretFields(schema Object) []string {
	out := []string{}
	for _, path := range schemaSecretPointers(schema) {
		if path == "" {
			out = append(out, "*")
			continue
		}
		p := strings.TrimPrefix(path, "/")
		p = strings.ReplaceAll(p, "/", ".")
		out = append(out, strings.ReplaceAll(strings.ReplaceAll(p, "~1", "/"), "~0", "~"))
	}
	sort.Strings(out)
	return out
}

func pointerPart(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}

// Snapshot schema-declared secret paths with encrypted drafts, including secrets with custom names.
func (g *HTTPGateway) ResourceSecretPaths(ctx context.Context, kind, resourceID string, values ...Object) ([]string, error) {
	names := map[string]bool{}
	for _, value := range values {
		plugins, _ := clean(value)["plugins"].(map[string]any)
		for name := range plugins {
			names[name] = true
		}
	}
	paths := []string{}
	if kind == "ssls" {
		paths = append(paths, "/key", "/keys", "/client/key")
	}
	if kind == "secrets" {
		for _, v := range values {
			for k := range v {
				switch k {
				case "uri", "prefix", "namespace", "region", "id", "create_time", "update_time":
				default:
					paths = append(paths, "/"+pointerPart(k))
				}
			}
		}
	}
	if kind == "plugin_metadata" {
		cached, ok := g.schemas.Load("metadata-catalog")
		if !ok {
			var all map[string]Object
			if err := g.request(ctx, "GET", "/plugins?all=true", nil, &all); err != nil {
				return []string{"/*"}, nil
			}
			g.schemas.Store("metadata-catalog", all)
			cached = all
		}
		schema, ok := cached.(map[string]Object)[resourceID]["metadata_schema"].(map[string]any)
		if !ok {
			return []string{"/*"}, nil
		}
		paths = append(paths, schemaSecretPointers(schema)...)

	}

	scope := "route"
	if kind == "consumers" || kind == "credentials" {
		scope = "consumer"
	}
	for name := range names {
		var schema Object
		var err error
		if kind == "stream_routes" {
			err = g.request(ctx, "GET", "/plugins/"+url.PathEscape(name)+"?subsystem=stream", nil, &schema)
		} else {
			schema, err = g.PluginSchemaFor(ctx, name, scope)
		}
		if err != nil {
			return nil, err
		}
		for _, path := range schemaSecretPointers(schema) {
			paths = append(paths, "/plugins/"+pointerPart(name)+path)
		}
	}
	sort.Strings(paths)
	return paths, nil
}
