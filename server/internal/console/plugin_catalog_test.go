package console

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCatalogDiscoversConsumerSchemasAndLegacySharedSchema(t *testing.T) {
	var metadata map[string]Object
	_ = json.Unmarshal([]byte(`{
 "custom-auth":{"type":"auth","schema":{"type":"object"},"consumer_schema":{"type":"object","encrypt_fields":["credential"],"properties":{"nested":{"type":"object","properties":{"opaque":{"type":"string","writeOnly":true}}}}}},
 "wolf-rbac":{"type":"auth","schema":{"type":"object"}},
 "multi-auth":{"type":"auth","schema":{"type":"object"}},
 "limit-count":{"schema":{"type":"object"}},
 "global-only":{"scope":"global","schema":{"type":"object"}}
 }`), &metadata)
	for _, name := range []string{"custom-auth", "wolf-rbac", "limit-count"} {
		if !pluginDefinition(name, metadata[name]).ConsumerConfigurable {
			t.Fatalf("%s not available", name)
		}
	}
	for _, name := range []string{"multi-auth", "global-only"} {
		if pluginDefinition(name, metadata[name]).ConsumerConfigurable {
			t.Fatalf("%s incorrectly offered on consumers", name)
		}
	}
	custom := pluginDefinition("custom-auth", metadata["custom-auth"])
	if custom.ConsumerSource != "dedicated" || strings.Join(custom.ConsumerSecrets, ",") != "credential,nested.opaque" {
		t.Fatal("dynamic metadata lost")
	}
	if pluginDefinition("wolf-rbac", metadata["wolf-rbac"]).ConsumerSource != "shared" {
		t.Fatal("legacy shared schema lost")
	}
}

func TestConsumerSchemaFallbackOnlyForUnsupportedContext(t *testing.T) {
	for _, status := range []int{400, 403, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			fallback := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("schema_type") == "consumer" {
					w.WriteHeader(status)
					_, _ = w.Write([]byte(`{"error_msg":"unavailable"}`))
					return
				}
				fallback++
				_, _ = w.Write([]byte(`{"type":"object","properties":{"appid":{"type":"string"}}}`))
			}))
			defer server.Close()
			g, _ := NewGateway(server.URL, "test")
			schema, err := g.PluginSchemaFor(context.Background(), "wolf-rbac", "consumer")
			if status == 400 {
				if err != nil || schema["properties"] == nil || fallback != 1 {
					t.Fatal("expected shared schema fallback", err)
				}
				_, _ = g.PluginSchemaFor(context.Background(), "wolf-rbac", "consumer")
				if fallback != 1 {
					t.Fatal("request-local schema cache not used")
				}
			} else if err == nil || fallback != 0 {
				t.Fatal("upstream authorization/server error was hidden")
			}
		})
	}
}

func TestConsumerValidationAcceptsSharedSchemaWithoutRequiredList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/schema/validate/") {
			w.WriteHeader(200)
			return
		}
		if r.URL.Query().Get("schema_type") == "consumer" {
			w.WriteHeader(400)
			return
		}
		_, _ = w.Write([]byte(`{"type":"object","properties":{"appid":{"type":"string"},"server":{"type":"string"}}}`))
	}))
	defer server.Close()
	g, _ := NewGateway(server.URL, "test")
	if err := g.Validate(context.Background(), "consumers", Object{"username": "wolf-client", "plugins": Object{"wolf-rbac": Object{"appid": "app", "server": "http://fixture"}}}); err != nil {
		t.Fatal(err)
	}
}

func TestSchemaDeclaredSecretsSurviveDraftReleaseAndRollbackRedaction(t *testing.T) {
	path := []string{"/plugins/custom-auth/nested/opaque~1value"}
	before := Object{"plugins": Object{"custom-auth": Object{"nested": Object{"opaque/value": "private-before"}}}}
	after := Object{"plugins": Object{"custom-auth": Object{"nested": Object{"opaque/value": "private-after"}}}}
	vault, _ := NewVault(strings.Repeat("a", 64))
	sealed, err := vault.Seal(DraftPayload{Before: before, After: after, SensitivePaths: path})
	if err != nil {
		t.Fatal(err)
	}
	var payload DraftPayload
	if err := vault.Open(sealed, &payload); err != nil {
		t.Fatal(err)
	}
	draft := publicDraft(Draft{Before: payload.Before, After: payload.After, SensitivePaths: payload.SensitivePaths})
	change := publicChange(Change{Operations: []Operation{{Before: payload.Before, After: payload.After, ActualAfter: payload.After, SensitivePaths: payload.SensitivePaths}}})
	encoded, _ := json.Marshal([]any{draft, change})
	if strings.Contains(string(encoded), "private-") || len(draft.Diff) != 1 || !draft.Diff[0].Sensitive {
		t.Fatal("schema-declared field exposed in stored snapshots")
	}
	restored, err := restoreSecrets(redact(after, path), after)
	if err != nil || hash(Object(restored.(map[string]any))) != hash(after) {
		t.Fatal("schema-declared field could not be retained")
	}
}

func TestConsumerCredentialLuaConstraints(t *testing.T) {
	for _, entry := range []struct {
		name  string
		value Object
		valid bool
	}{
		{"jwt-auth", Object{"key": "id"}, false}, {"jwt-auth", Object{"key": "id", "secret": "secret"}, true},
		{"jwt-auth", Object{"key": "id", "algorithm": "RS256", "secret": "wrong-field"}, false},
		{"jwt-auth", Object{"key": "id", "algorithm": "RS256", "public_key": "public-key"}, true},
		{"jwe-decrypt", Object{"key": "id", "secret": "short"}, false},
		{"jwe-decrypt", Object{"key": "id", "secret": strings.Repeat("x", 32)}, true},
		{"jwe-decrypt", Object{"key": "id", "secret": "not valid base64", "is_base64_encoded": true}, false},
		{"jwe-decrypt", Object{"key": "id", "secret": "$env://JWE_SECRET"}, true},
	} {
		if (validateConsumerCredential(entry.name, entry.value) == nil) != entry.valid {
			t.Fatalf("%s credential constraints not enforced", entry.name)
		}
	}
}

func TestEmptyAuthenticationPluginProducesAdditionAndRemovalDiff(t *testing.T) {
	before := Object{"uri": "/health"}
	after := Object{"uri": "/health", "plugins": Object{"wolf-rbac": Object{}}}
	added := differences(before, after)
	if len(added) != 1 || added[0].Path != "/plugins/wolf-rbac" || added[0].Kind != "add" {
		t.Fatal("empty plugin addition was treated as no change", added)
	}
	removed := differences(after, before)
	if len(removed) != 1 || removed[0].Kind != "remove" {
		t.Fatal("empty plugin removal was lost", removed)
	}
	if len(differences(after, after)) != 0 {
		t.Fatal("unchanged empty plugin marked changed")
	}
}

func TestConsumerIdentityUniquenessAcrossAuthenticationMethods(t *testing.T) {
	for name, field := range map[string]string{"basic-auth": "username", "jwt-auth": "key", "hmac-auth": "key_id", "jwe-decrypt": "key", "ldap-auth": "user_dn", "ldap-auth-advanced": "user_dn", "wolf-rbac": "appid"} {
		t.Run(name, func(t *testing.T) {
			g := &fakeGateway{resources: map[string]Object{"consumers/one": {"username": "one", "plugins": Object{name: Object{field: "private-identity"}}}}}
			ops := []Operation{{ResourceType: "consumers", ResourceID: "two", After: Object{"username": "two", "plugins": Object{name: Object{field: "private-identity"}}}}}
			err := checkConsumerReferences(context.Background(), g, ops)
			if err == nil || strings.Contains(err.Error(), "private-identity") {
				t.Fatal("duplicate identity accepted or exposed")
			}
		})
	}
}

func TestPluginArrayDefaultsFromLua(t *testing.T) {
	var schema Object
	if err := json.Unmarshal([]byte(`{"type":"object","properties":{"headers":{"type":"array","default":{},"items":{"type":"string"}},"options":{"type":"object","default":{}}}}`), &schema); err != nil {
		t.Fatal(err)
	}
	normalizePluginSchema(schema)
	for _, config := range []Object{{}, {"headers": []string{"X-Order"}}} {
		if err := validatePluginSchema(schema, config); err != nil {
			t.Fatal(err)
		}
	}
	if err := validatePluginSchema(schema, Object{"headers": Object{}}); err == nil {
		t.Fatal("an explicit object must still fail array validation")
	}
}
