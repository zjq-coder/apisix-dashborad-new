package console

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConsumerUsernameControlsWriteTarget(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "PUT" || r.URL.Path != "/apisix/admin/consumers" {
			t.Error("incorrect consumer endpoint")
		}
		var body Object
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["username"] != "client" || body["id"] != nil {
			t.Error("incorrect consumer payload")
		}
		w.WriteHeader(200)
	}))
	defer server.Close()
	g, _ := NewGateway(server.URL, "admin-test-key")
	if err := g.Put(context.Background(), "consumers", "client", Object{"username": "someone-else"}); err == nil || calls != 0 {
		t.Fatal("mismatched target was written")
	}
	if err := g.Put(context.Background(), "consumers", "client", Object{"username": "client", "id": "metadata"}); err != nil || calls != 1 {
		t.Fatal("consumer write failed", err)
	}
	for _, name := range []string{"client.with.dot", "../client", "", strings.Repeat("x", 257)} {
		if resourceIDOK("consumers", name) {
			t.Fatal("invalid consumer name accepted")
		}
	}
	if !resourceIDOK("consumers", strings.Repeat("x", 256)) {
		t.Fatal("valid long username rejected")
	}
}

func TestConsumerListUsesUsernameRatherThanMetadataID(t *testing.T) {
	r := resourceFromNode(Object{"key": "/apisix/consumers/client", "value": map[string]any{"id": "unrelated-metadata", "username": "client"}}, "consumers")
	if r.ID != "client" {
		t.Fatal("consumer identified by wrong field")
	}
}

func TestConsumerValidationUsesCredentialSchema(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apisix/admin/schema/validate/consumers" {
			w.WriteHeader(200)
			return
		}
		if r.URL.Path != "/apisix/admin/plugins/key-auth" || r.URL.Query().Get("schema_type") != "consumer" {
			t.Error("route schema used for consumer")
		}
		_, _ = w.Write([]byte(`{"type":"object","required":["key"],"properties":{"key":{"type":"string"}}}`))
	}))
	defer server.Close()
	g, _ := NewGateway(server.URL, "test")
	for _, plugin := range []Object{{"header": "apikey"}, {"key": ""}, {"key": 123}} {
		if g.Validate(context.Background(), "consumers", Object{"username": "client", "plugins": Object{"key-auth": plugin}}) == nil {
			t.Fatal("invalid credential accepted")
		}
	}
	if err := g.Validate(context.Background(), "consumers", Object{"username": "client", "plugins": Object{"key-auth": Object{"key": "unique-test-value"}}}); err != nil {
		t.Fatal(err)
	}
}

func TestConsumerSecretsAndRotationDiff(t *testing.T) {
	before := Object{"username": "client", "plugins": Object{"key-auth": Object{"key": "old-private-value"}}}
	masked := redact(before)
	resolved, err := restoreSecrets(masked, before)
	if err != nil || hash(Object(resolved.(map[string]any))) != hash(before) {
		t.Fatal("retaining credential failed")
	}
	after := Object{"username": "client", "plugins": Object{"key-auth": Object{"key": "new-private-value"}}}
	change := publicChange(Change{Operations: []Operation{{ResourceType: "consumers", Before: before, After: after, ActualAfter: after}}})
	encoded, _ := json.Marshal(change)
	if strings.Contains(string(encoded), "private-value") || len(change.Operations[0].Diff) != 1 || !change.Operations[0].Diff[0].Sensitive {
		t.Fatal("consumer credential exposed or rotation diff missing")
	}
}

func TestConsumerDuplicateKeyAndGroupReferences(t *testing.T) {
	one := Object{"username": "one", "plugins": Object{"key-auth": Object{"key": "private-duplicate"}}}
	two := Object{"username": "two", "plugins": Object{"key-auth": Object{"key": "private-duplicate"}}}
	g := &fakeGateway{resources: map[string]Object{"consumers/one": one}}
	op := Operation{ResourceType: "consumers", ResourceID: "two", Action: "create", After: two}
	if err := checkReferences(context.Background(), g, []Operation{op}); err == nil || strings.Contains(err.Error(), "private-duplicate") {
		t.Fatal("duplicate key accepted or leaked", err)
	}
	if err := checkReferences(context.Background(), g, []Operation{{ResourceType: "consumers", ResourceID: "one", Action: "update", After: one}}); err != nil {
		t.Fatal("unchanged own key rejected", err)
	}
	op.After = Object{"username": "two", "group_id": "missing"}
	if checkReferences(context.Background(), g, []Operation{op}) == nil {
		t.Fatal("missing consumer group accepted")
	}
	g.resources["consumer_groups/missing"] = Object{}
	if err := checkReferences(context.Background(), g, []Operation{op}); err != nil {
		t.Fatal(err)
	}
}
