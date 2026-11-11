package console

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
)

// Consumer authentication uses consumer_schema; other consumer policies use the normal schema.
func (g *HTTPGateway) validateConsumerPlugins(ctx context.Context, value Object) error {
	plugins, _ := clean(value)["plugins"].(map[string]any)
	for name, config := range plugins {
		if !idPattern.MatchString(name) {
			return fmt.Errorf("消费者插件名称不正确")
		}
		schema, err := g.PluginSchemaFor(ctx, name, "consumer")
		if err != nil {
			return err
		}
		if err = validatePluginSchema(schema, config); err != nil {
			return fmt.Errorf("消费者插件 %s：%w", name, err)
		}
		fields, _ := config.(map[string]any)
		required, _ := schema["required"].([]any)
		for _, raw := range required {
			key := stringValue(raw)
			if text, ok := fields[key].(string); ok && strings.TrimSpace(text) == "" {
				return fmt.Errorf("消费者插件 %s 的 %s 不能为空", name, key)
			}
		}
		if err := validateConsumerCredential(name, fields); err != nil {
			return err
		}
	}
	return nil
}

// These constraints live in APISIX Lua check_schema rather than its JSON Schema.
func validateConsumerCredential(name string, fields map[string]any) error {
	if name == "jwt-auth" {
		algorithm := stringValue(fields["algorithm"])
		if algorithm == "" || strings.HasPrefix(algorithm, "HS") {
			if stringValue(fields["secret"]) == "" {
				return fmt.Errorf("JWT 对称签名算法必须配置 secret")
			}
		} else if stringValue(fields["public_key"]) == "" {
			return fmt.Errorf("JWT 非对称签名算法必须配置 public_key")
		}
		secret := stringValue(fields["secret"])
		if fields["base64_secret"] == true && secret != "" && !strings.HasPrefix(secret, "$secret://") && !strings.HasPrefix(secret, "$env://") {
			if _, err := base64.StdEncoding.DecodeString(secret); err != nil {
				if _, rawErr := base64.RawStdEncoding.DecodeString(secret); rawErr != nil {
					return fmt.Errorf("启用 base64_secret 时 JWT secret 必须是合法的 Base64 编码")
				}
			}
		}
	}
	if name == "jwe-decrypt" && !strings.HasPrefix(stringValue(fields["secret"]), "$secret://") && !strings.HasPrefix(stringValue(fields["secret"]), "$env://") {
		secret := []byte(stringValue(fields["secret"]))
		if fields["is_base64_encoded"] == true {
			var err error
			secret, err = base64.RawURLEncoding.DecodeString(strings.TrimRight(string(secret), "="))
			if err != nil {
				return fmt.Errorf("JWE secret 必须是合法的 Base64URL 编码")
			}
		}
		if len(secret) != 32 {
			return fmt.Errorf("JWE secret 解码后必须恰好为 32 字节")
		}
	}
	return nil
}

func checkConsumerReferences(ctx context.Context, g Gateway, ops []Operation) error {
	changed := map[string]Object{}
	for _, op := range ops {
		if op.ResourceType == "consumers" {
			changed[op.ResourceID] = op.After
		}
	}
	if len(changed) == 0 {
		return nil
	}
	consumers, err := g.List(ctx, "consumers")
	if err != nil {
		return err
	}
	final := map[string]Object{}
	for _, consumer := range consumers {
		final[consumer.ID] = consumer.Value
	}
	for id, value := range changed {
		if value == nil {
			delete(final, id)
		} else {
			final[id] = value
		}

	}
	keys := map[string]string{}
	for id, value := range final {
		plugins, _ := clean(value)["plugins"].(map[string]any)
		for name, field := range map[string]string{"key-auth": "key", "basic-auth": "username", "hmac-auth": "key_id", "jwt-auth": "key", "jwe-decrypt": "key", "ldap-auth": "user_dn", "ldap-auth-advanced": "user_dn", "wolf-rbac": "appid"} {
			plugin, _ := plugins[name].(map[string]any)
			identifier, _ := plugin[field].(string)
			if identifier == "" {
				continue
			}
			key := name + "\x00" + identifier
			if other, exists := keys[key]; exists && (changed[id] != nil || changed[other] != nil) {
				return fmt.Errorf("消费者插件 %s 的 %s 已被其他消费者使用", name, field)
			}
			keys[key] = id
		}
	}
	return nil
}
