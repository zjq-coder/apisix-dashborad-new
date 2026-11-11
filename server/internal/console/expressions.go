package console

import (
	"fmt"
	"strings"
)

// Entity JSON Schema accepts arbitrary vars arrays. Match the structural rules
// of lua-resty-expr before publish; PCRE compilation still belongs to APISIX.
func validateExpression(value any, path string, depth int) error {
	if depth > 12 {
		return fmt.Errorf("%s 条件嵌套过深", path)
	}
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return fmt.Errorf("%s 必须是非空条件数组", path)
	}
	start := 0
	if first, ok := items[0].(string); ok {
		switch strings.ToUpper(first) {
		case "AND", "OR", "!AND", "!OR":
			if len(items) < 3 {
				return fmt.Errorf("%s 显式条件组至少需要两条规则", path)
			}
			start = 1
		default:
			negated := len(items) > 1 && items[1] == "!"
			if (!negated && len(items) != 3) || (negated && len(items) != 4) {
				return fmt.Errorf("%s 条件结构不正确", path)
			}
			return nil
		}
	}
	for i := start; i < len(items); i++ {
		if err := validateExpression(items[i], fmt.Sprintf("%s[%d]", path, i), depth+1); err != nil {
			return err
		}
	}
	return nil
}

func validateRouteExpressions(value Object) error {
	if vars, ok := value["vars"]; ok {
		if err := validateExpression(vars, "vars", 0); err != nil {
			return err
		}
	}
	plugins, _ := value["plugins"].(map[string]any)
	if object, ok := value["plugins"].(Object); ok {
		plugins = object
	}
	for name, item := range plugins {
		plugin, _ := item.(map[string]any)
		if object, ok := item.(Object); ok {
			plugin = object
		}
		meta, _ := plugin["_meta"].(map[string]any)
		if object, ok := plugin["_meta"].(Object); ok {
			meta = object
		}
		if filter, ok := meta["filter"]; ok {
			if err := validateExpression(filter, "plugins."+name+"._meta.filter", 0); err != nil {
				return err
			}
		}
	}
	return nil
}
