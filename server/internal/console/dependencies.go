package console

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

type resourceRef struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

func (p resourceRef) String() string { return p.Kind + "/" + p.ID }

// Visit explicit APISIX identity fields. Each value is normalized from JSON before traversal.
func visitReferences(kind, id string, v Object, visit func(resourceRef) string) {
	if v == nil {
		return
	}
	field := func(m map[string]any, key, target string) {
		if s := stringValue(m[key]); s != "" {
			dst := visit(resourceRef{target, s})
			if dst != s {
				m[key] = dst
			}
		}
	}
	rewriteSecretRefs(map[string]any(v), visit)
	switch kind {
	case "routes", "stream_routes", "services":
		field(v, "upstream_id", "upstreams")
		if kind == "routes" {
			field(v, "service_id", "services")
			field(v, "plugin_config_id", "plugin_configs")
		}
	case "consumers":
		field(v, "group_id", "consumer_groups")
	case "credentials":
		owner, _, _ := strings.Cut(id, ":")
		visit(resourceRef{"consumers", owner})
	}
	upstream := map[string]any(v)
	if kind != "upstreams" {
		upstream, _ = v["upstream"].(map[string]any)
	}
	tls, _ := upstream["tls"].(map[string]any)
	field(tls, "client_cert_id", "ssls")
	plugins, _ := v["plugins"].(map[string]any)
	grpc, _ := plugins["grpc-transcode"].(map[string]any)
	field(grpc, "proto_id", "protos")
	split, _ := plugins["traffic-split"].(map[string]any)
	rules, _ := split["rules"].([]any)
	for _, raw := range rules {
		rule, _ := raw.(map[string]any)
		items, _ := rule["weighted_upstreams"].([]any)
		for _, entry := range items {
			obj, _ := entry.(map[string]any)
			field(obj, "upstream_id", "upstreams")
		}
	}
}

// Only the provider and configuration ID form a dependency. The remote secret path stays private.
func rewriteSecretRefs(v any, visit func(resourceRef) string) any {
	switch value := v.(type) {
	case map[string]any:
		for k, child := range value {
			value[k] = rewriteSecretRefs(child, visit)
		}
	case []any:
		for i, child := range value {
			value[i] = rewriteSecretRefs(child, visit)
		}
	case string:
		if strings.HasPrefix(strings.ToLower(value), "$secret://") {
			parts := strings.SplitN(value[len("$secret://"):], "/", 3)
			if len(parts) != 3 {
				return v
			}
			original := strings.ToLower(parts[0]) + ":" + parts[1]
			target := visit(resourceRef{"secrets", original})
			if target != original {
				return "$secret://" + strings.Replace(target, ":", "/", 1) + "/" + parts[2]
			}
		}
	}
	return v
}

var parentKinds = map[string][]string{
	"secrets":   {"routes", "services", "upstreams", "stream_routes", "plugin_configs", "global_rules", "plugin_metadata", "consumer_groups", "consumers", "credentials"},
	"upstreams": {"routes", "services", "stream_routes", "plugin_configs", "global_rules", "consumer_groups", "consumers"},
	"services":  {"routes"}, "plugin_configs": {"routes"}, "consumer_groups": {"consumers"},
	"protos": {"routes", "services", "plugin_configs", "global_rules", "consumer_groups", "consumers"},
	"ssls":   {"upstreams", "routes", "services", "stream_routes"},
}

func listParents(ctx context.Context, g Gateway, kind string) ([]Resource, error) {
	gw, ok := g.(*HTTPGateway)
	if kind != "credentials" || !ok {
		return g.List(ctx, kind)
	}
	consumers, err := g.List(ctx, "consumers")
	if err != nil {
		return nil, err
	}
	var credentials []Resource
	for _, c := range consumers {
		items, err := gw.listCredentials(ctx, c.ID)
		if isNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		credentials = append(credentials, items...)
	}
	return credentials, nil
}
func directRefs(kind, id string, value Object) []resourceRef {
	refs := []resourceRef{}
	visitReferences(kind, id, clean(value), func(ref resourceRef) string { refs = append(refs, ref); return ref.ID })
	return refs
}

func checkReferences(ctx context.Context, g Gateway, ops []Operation) error {
	final := map[resourceRef]Object{}
	for _, op := range ops {
		final[resourceRef{op.ResourceType, op.ResourceID}] = op.After
	}
	names := map[string]string{"upstreams": "上游", "services": "服务", "plugin_configs": "插件配置", "consumer_groups": "消费者组"}
	cached := map[string][]Resource{}
	for _, op := range ops {
		me := resourceRef{op.ResourceType, op.ResourceID}
		if op.After != nil {
			for _, ref := range directRefs(me.Kind, me.ID, op.After) {
				if !resourceIDOK(ref.Kind, ref.ID) {
					return fmt.Errorf("无效的引用标识 %s", ref)
				}
				value, found := final[ref]
				if !found {
					var err error
					value, err = g.Get(ctx, ref.Kind, ref.ID)
					if err != nil {
						return err
					}
					final[ref] = value
				}
				if value == nil {
					return fmt.Errorf("%s 引用的%s %s 不存在", me, names[ref.Kind], ref)
				}
			}
			continue
		}
		for _, kind := range parentKinds[me.Kind] {
			items, ok := cached[kind]
			if !ok {
				var err error
				items, err = listParents(ctx, g, kind)
				if errors.Is(err, errStreamDisabled) {
					continue
				}
				if err != nil {
					return err
				}
				cached[kind] = items
			}
			for _, item := range items {
				value := item.Value
				if after, ok := final[resourceRef{kind, item.ID}]; ok {
					value = after
				}
				for _, ref := range directRefs(kind, item.ID, value) {
					if ref == me {
						return fmt.Errorf("%s 仍被 %s/%s 引用", me, kind, item.ID)
					}
				}
			}
		}
		if me.Kind == "consumers" {
			if gw, ok := g.(*HTTPGateway); ok {
				items, err := gw.listCredentials(ctx, me.ID)
				if err != nil && !isNotFound(err) {
					return err
				}
				for _, item := range items {
					if after, ok := final[resourceRef{"credentials", item.ID}]; !ok || after != nil {
						return fmt.Errorf("请先删除消费者的独立凭据 %s", item.ID)
					}
				}
			}
		}
	}
	return checkConsumerReferences(ctx, g, ops)
}

var errStreamDisabled = errors.New("目标集群未开启 Stream 模式")

func validateTarget(ctx context.Context, g Gateway, kind, id string, v Object) error {
	if gw, ok := g.(*HTTPGateway); ok && (kind == "plugin_configs" || kind == "global_rules" || kind == "consumer_groups") {
		body := clean(v)
		body["id"] = id
		if err := gw.request(ctx, "POST", "/schema/validate/"+kind, body, nil); err != nil {
			return err
		}
		return validateRoutePlugins(ctx, g, v)
	}
	if gw, ok := g.(*HTTPGateway); ok && (kind == "secrets" || kind == "plugin_metadata" || kind == "protos" || kind == "stream_routes" || kind == "credentials") {
		body := clean(v)
		section := kind
		key := id
		if kind == "secrets" {
			key = strings.Replace(id, ":", "/", 1)
		}
		if kind == "credentials" {
			key = strings.Replace(id, ":", "/credentials/", 1)
			section = "consumers"
		}
		body["id"] = key
		// This endpoint runs the installed Lua checker, including Proto compilation and the Secret provider schema.
		return gw.request(ctx, "POST", "/configs/validate", Object{section: []Object{body}}, nil)
	}
	return g.Validate(ctx, kind, v)
}
