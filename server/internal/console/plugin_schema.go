package console

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

// APISIX's entity validation endpoint does not run individual plugin schemas.
// Fetch the installed plugin schema and validate it separately on the server.
func validateRoutePlugins(ctx context.Context, g Gateway, value Object) error {
	plugins, _ := value["plugins"].(map[string]any)
	if len(plugins) == 0 {
		if p, ok := value["plugins"].(Object); ok {
			plugins = map[string]any(p)
		}
	}
	if len(plugins) == 0 {
		return nil
	}
	enabled, err := g.Plugins(ctx)
	if err != nil {
		return err
	}
	available := map[string]bool{}
	for _, name := range enabled {
		available[name] = true
	}
	names := []string{}
	for name := range plugins {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !available[name] {
			return fmt.Errorf("插件 %s 未在目标集群启用", name)
		}
		schema, err := g.PluginSchema(ctx, name)
		if err != nil {
			return err
		}
		if err = validatePluginSchema(schema, plugins[name]); err != nil {
			return fmt.Errorf("插件 %s：%w", name, err)
		}
	}
	return nil
}

func applySchemaDefaults(schema map[string]any, value any) {
	switch obj := value.(type) {
	case map[string]any:
		properties, _ := schema["properties"].(map[string]any)
		for key, definition := range properties {
			field, _ := definition.(map[string]any)
			if _, exists := obj[key]; !exists {
				if def, ok := field["default"]; ok {
					obj[key] = def
				}
			}
			if item, ok := obj[key]; ok {
				applySchemaDefaults(field, item)
			}
		}
	case []any:
		items, _ := schema["items"].(map[string]any)
		for _, item := range obj {
			applySchemaDefaults(items, item)
		}
	}
}

func validatePluginSchema(schema Object, config any) error {
	compiler := jsonschema.NewCompiler()
	compiler.Draft = jsonschema.Draft7
	// A cluster-provided schema must never make the console fetch arbitrary URLs or files.
	compiler.LoadURL = func(string) (io.ReadCloser, error) { return nil, fmt.Errorf("external schema references are disabled") }
	encoded, err := json.Marshal(schema)
	if err != nil {
		return fmt.Errorf("插件 Schema 无法读取")
	}
	const schemaURL = "https://dashboard.invalid/plugin-schema.json"
	if err = compiler.AddResource(schemaURL, bytes.NewReader(encoded)); err != nil {
		return fmt.Errorf("插件 Schema 无法解析")
	}
	compiled, err := compiler.Compile(schemaURL)
	if err != nil {
		return fmt.Errorf("插件 Schema 含有当前校验器不支持的定义，请检查版本适配")
	}
	encoded, err = json.Marshal(config)
	if err != nil {
		return fmt.Errorf("插件配置无法解析")
	}
	var normalized any
	if err = json.Unmarshal(encoded, &normalized); err != nil {
		return fmt.Errorf("插件配置无法解析")
	}
	// Defaults only affect the validation copy. The original draft is preserved.
	applySchemaDefaults(map[string]any(clone(schema)), normalized)
	if err = compiled.Validate(normalized); err == nil {
		return nil
	}
	if validation, ok := err.(*jsonschema.ValidationError); ok {
		for len(validation.Causes) > 0 {
			validation = validation.Causes[0]
		}
		path := validation.InstanceLocation
		if path == "" {
			path = "/"
		}
		keyword := validation.KeywordLocation[strings.LastIndex(validation.KeywordLocation, "/")+1:]
		// Never return validation messages that may include a secret input value.
		return fmt.Errorf("字段 %s 不符合 %s 约束，请检查必填项、类型和取值", path, keyword)
	}
	return fmt.Errorf("插件参数未通过 Schema 校验")
}
