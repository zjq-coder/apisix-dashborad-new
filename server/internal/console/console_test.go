package console

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSecretRoundTripAndDiff(t *testing.T) {
	before := Object{"name": "api", "plugins": map[string]any{"openid-connect": map[string]any{"client_secret": "sensitive-value-a91", "client_id": "public"}, "limit-req": map[string]any{"key": "remote_addr", "rate": float64(10)}}, "future_field": map[string]any{"nested": []any{true, "value"}}}
	redacted := redact(before)
	encoded, _ := json.Marshal(redacted)
	if strings.Contains(string(encoded), "sensitive-value-a91") || !strings.Contains(string(encoded), "remote_addr") {
		t.Fatal("secret exposure or rate key over-redacted")
	}
	resolved, err := restoreSecrets(redacted, before)
	if err != nil {
		t.Fatal(err)
	}
	after := Object(resolved.(map[string]any))
	if hash(after) != hash(before) {
		t.Fatal("unknown fields lost during round trip")
	}
	after["plugins"].(map[string]any)["openid-connect"].(map[string]any)["client_secret"] = "replacement"
	diff := differences(before, after)
	if len(diff) != 1 || !diff[0].Sensitive {
		t.Fatalf("expected one sensitive change: %+v", diff)
	}
	encoded, _ = json.Marshal(diff)
	if strings.Contains(string(encoded), "sensitive-value-a91") || strings.Contains(string(encoded), "replacement") {
		t.Fatal("diff leaked secret")
	}
	if _, err = restoreSecrets(Object{"secret": KeepSecret}, nil); err == nil {
		t.Fatal("accepted nonexistent secret placeholder")
	}
}
func TestVaultAuthenticatesAndDoesNotStorePlaintext(t *testing.T) {
	v, err := NewVault(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := v.Seal(Object{"token": "private-value"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(cipher, "private-value") {
		t.Fatal("plaintext storage")
	}
	var decoded Object
	if err = v.Open(cipher, &decoded); err != nil || decoded["token"] != "private-value" {
		t.Fatal("round trip failed", err)
	}
	other, _ := NewVault(strings.Repeat("cd", 32))
	if other.Open(cipher, &decoded) == nil {
		t.Fatal("wrong key accepted")
	}
}
func TestHashDetectsMeaningfulChanges(t *testing.T) {
	a := Object{"id": "x", "create_time": float64(1), "uri": "/a", "methods": []any{"GET", "POST"}}
	b := clone(a)
	b["update_time"] = float64(42)
	if hash(a) != hash(b) {
		t.Fatal("metadata caused false conflict")
	}
	b["uri"] = "/b"
	if hash(a) == hash(b) {
		t.Fatal("missed configuration change")
	}
}
func TestNormalizeURLRejectsCredentialLeaks(t *testing.T) {
	for _, value := range []string{"file:///etc/passwd", "http://user:pass@localhost:9180", "http://localhost:9180?token=secret", "https://localhost/other", "http://localhost/#key"} {
		if _, err := normalizeURL(value); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
	base, err := normalizeURL("http://localhost:9180/")
	if err != nil || base != "http://localhost:9180/apisix/admin" {
		t.Fatal(base, err)
	}
}
func TestGatewayNeverForwardsCredentialsAcrossRedirect(t *testing.T) {
	called := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer source.Close()
	g, _ := NewGateway(source.URL, "private-key")
	if _, err := g.Plugins(context.Background()); err == nil || called {
		t.Fatal("redirect followed")
	}
}
func TestGatewayPaginationAndExtraction(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-KEY") != "key" {
			t.Error("missing auth")
		}
		list := []Object{}
		if r.URL.Query().Get("page") == "1" {
			for i := 0; i < 500; i++ {
				list = append(list, Object{"value": Object{"id": fmt.Sprint(i), "uri": "/x"}})
			}
		} else {
			list = append(list, Object{"value": Object{"id": "last", "uri": "/last"}})
		}
		_ = json.NewEncoder(w).Encode(Object{"list": list, "total": 501})
	}))
	defer server.Close()
	g, _ := NewGateway(server.URL, "key")
	items, err := g.List(context.Background(), "routes")
	if err != nil || len(items) != 501 || items[500].ID != "last" {
		t.Fatal(len(items), err)
	}
}
func TestGatewayEmptyLuaTable(t *testing.T) {
	for _, body := range []string{`{"total":0,"list":{}}`, `{"total":0,"list":[]}`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
		g, _ := NewGateway(server.URL, "key")
		items, err := g.List(context.Background(), "routes")
		server.Close()
		if err != nil || len(items) != 0 {
			t.Fatal(items, err)
		}
	}
}

type fakeGateway struct {
	resources      map[string]Object
	writes         []string
	writeError     error
	readAfterError bool
	altered        bool
}

func (f *fakeGateway) List(_ context.Context, kind string) ([]Resource, error) {
	items := []Resource{}
	for key, value := range f.resources {
		if strings.HasPrefix(key, kind+"/") {
			items = append(items, Resource{ID: strings.TrimPrefix(key, kind+"/"), Value: clone(value)})
		}
	}
	return items, nil
}
func (f *fakeGateway) Get(_ context.Context, kind, id string) (Object, error) {
	if f.readAfterError && len(f.writes) > 0 {
		return nil, errors.New("connection lost")
	}
	return clone(f.resources[kind+"/"+id]), nil
}
func (f *fakeGateway) Put(_ context.Context, kind, id string, v Object) error {
	f.writes = append(f.writes, kind+"/"+id)
	f.resources[kind+"/"+id] = clone(v)
	if f.altered {
		f.resources[kind+"/"+id]["name"] = "external-change"
	}
	return f.writeError
}
func (f *fakeGateway) Delete(_ context.Context, kind, id string) error {
	f.writes = append(f.writes, kind+"/"+id)
	delete(f.resources, kind+"/"+id)
	return f.writeError
}
func (f *fakeGateway) Validate(context.Context, string, Object) error       { return nil }
func (f *fakeGateway) Plugins(context.Context) ([]string, error)            { return []string{}, nil }
func (f *fakeGateway) PluginSchema(context.Context, string) (Object, error) { return Object{}, nil }
func TestReferenceResourcesSupportDrafts(t *testing.T) {
	for _, kind := range []string{"services", "plugin_configs"} {
		if !readableResourceType(kind) || !resourceTypeOK(kind) {
			t.Fatalf("incorrect access for %s", kind)
		}
	}
	if !readableResourceType("consumers") || !resourceTypeOK("consumers") || readableResourceType("../routes") {
		t.Fatal("unexpected readable resource type")
	}
}
func TestExpressionGroupsRejectRuntimeInvalidShapes(t *testing.T) {
	for _, raw := range []string{`[]`, `["OR",["arg_a","==","yes"]]`, `[["arg_x","=="]]`, `["AND",true,false]`} {
		var value any
		_ = json.Unmarshal([]byte(raw), &value)
		if validateExpression(value, "vars", 0) == nil {
			t.Fatalf("accepted invalid expression %s", raw)
		}
	}
	for _, raw := range []string{`[["arg_a","==","yes"]]`, `["OR",["arg_a","==","yes"],["arg_b","!","==",false]]`, `[["arg_n",">=",0],["OR",["http_x","==","a"],["cookie_x","==",null]]]`} {
		var value any
		_ = json.Unmarshal([]byte(raw), &value)
		if err := validateExpression(value, "vars", 0); err != nil {
			t.Fatal(err)
		}
	}
}
func TestInvalidPluginExecutionConditionIsRejected(t *testing.T) {
	var value Object
	_ = json.Unmarshal([]byte(`{"plugins":{"proxy-rewrite":{"_meta":{"filter":["OR",["arg_x","==","x"]]}}}}`), &value)
	if err := validateRouteExpressions(value); err == nil || !strings.Contains(err.Error(), "_meta.filter") {
		t.Fatal("invalid plugin filter accepted", err)
	}
}
func TestRouteServiceAndPluginConfigReferences(t *testing.T) {
	g := &fakeGateway{resources: map[string]Object{"services/s": {"upstream": Object{"nodes": Object{"echo:80": 1}}}, "plugin_configs/p": {"plugins": Object{}}}}
	op := Operation{ResourceType: "routes", ResourceID: "r", Action: "create", After: Object{"uri": "/r", "service_id": "s", "plugin_config_id": "p"}}
	if err := checkReferences(context.Background(), g, []Operation{op}); err != nil {
		t.Fatal(err)
	}
	delete(g.resources, "plugin_configs/p")
	if err := checkReferences(context.Background(), g, []Operation{op}); err == nil || !strings.Contains(err.Error(), "插件配置") {
		t.Fatal("missing plugin config accepted", err)
	}
	g.resources["plugin_configs/p"] = Object{"plugins": Object{}}
	delete(g.resources, "services/s")
	if err := checkReferences(context.Background(), g, []Operation{op}); err == nil || !strings.Contains(err.Error(), "服务") {
		t.Fatal("missing service accepted", err)
	}
	if len(g.writes) != 0 {
		t.Fatal("reference check wrote to gateway")
	}
}
func TestConflictNeverWrites(t *testing.T) {
	g := &fakeGateway{resources: map[string]Object{"routes/r": Object{"uri": "/changed"}}}
	status, _, _ := applyOperation(context.Background(), g, Operation{ResourceType: "routes", ResourceID: "r", Action: "update", BaseHash: hash(Object{"uri": "/old"}), After: Object{"uri": "/new"}})
	if status != "conflict" || len(g.writes) != 0 {
		t.Fatal(status, g.writes)
	}
}
func TestLostAcknowledgmentUsesReadback(t *testing.T) {
	g := &fakeGateway{resources: map[string]Object{}, writeError: errors.New("timeout after commit")}
	status, actual, _ := applyOperation(context.Background(), g, Operation{ResourceType: "routes", ResourceID: "r", Action: "create", BaseHash: "absent", After: Object{"uri": "/new"}})
	if status != "applied" || actual["uri"] != "/new" || len(g.writes) != 1 {
		t.Fatal(status, actual)
	}
}
func TestUncertainWriteIsNotRetried(t *testing.T) {
	g := &fakeGateway{resources: map[string]Object{}, readAfterError: true}
	status, _, _ := applyOperation(context.Background(), g, Operation{ResourceType: "routes", ResourceID: "r", Action: "create", BaseHash: "absent", After: Object{"uri": "/new"}})
	if status != "unknown" || len(g.writes) != 1 {
		t.Fatal(status, g.writes)
	}
}
func TestUnexpectedReadbackIsUnknown(t *testing.T) {
	g := &fakeGateway{resources: map[string]Object{}, altered: true}
	status, _, _ := applyOperation(context.Background(), g, Operation{ResourceType: "routes", ResourceID: "r", Action: "create", BaseHash: "absent", After: Object{"uri": "/new"}})
	if status != "unknown" {
		t.Fatal(status)
	}
}
func TestBatchDependencyOrdering(t *testing.T) {
	ops := []Operation{{ResourceType: "upstreams", Action: "delete"}, {ResourceType: "routes", Action: "create"}, {ResourceType: "routes", Action: "delete"}, {ResourceType: "upstreams", Action: "create"}}
	orderOperations(ops)
	for i, op := range ops {
		if operationRank(op) != []int{0, 3, 4, 7}[i] {
			t.Fatal("invalid order", ops)
		}
	}
}
func TestReferenceChecksUnderstandCombinedChanges(t *testing.T) {
	g := &fakeGateway{resources: map[string]Object{}}
	ops := []Operation{{ResourceType: "routes", ResourceID: "r", Action: "create", After: Object{"uri": "/", "upstream_id": "u"}}, {ResourceType: "upstreams", ResourceID: "u", Action: "create", After: Object{"nodes": map[string]any{"echo:80": float64(1)}}}}
	if err := checkReferences(context.Background(), g, ops); err != nil {
		t.Fatal(err)
	}
	g.resources["routes/r"] = ops[0].After
	g.resources["upstreams/u"] = ops[1].After
	if err := checkReferences(context.Background(), g, []Operation{{ResourceType: "upstreams", ResourceID: "u", Action: "delete"}}); err == nil {
		t.Fatal("accepted dangling reference")
	}
	if err := checkReferences(context.Background(), g, []Operation{{ResourceType: "routes", ResourceID: "r", Action: "delete"}, {ResourceType: "upstreams", ResourceID: "u", Action: "delete"}}); err != nil {
		t.Fatal(err)
	}
}
func TestKnownAPISIXDefaultsAreEquivalent(t *testing.T) {
	want := Object{"uri": "/"}
	got := Object{"id": "r", "uri": "/", "status": float64(1), "priority": float64(0), "create_time": float64(123)}
	if !matchesWrite("routes", want, got) {
		t.Fatal("default normalization failed")
	}
	got["unexpected"] = true
	if matchesWrite("routes", want, got) {
		t.Fatal("unknown external mutation ignored")
	}
}
func TestOriginGuard(t *testing.T) {
	r := httptest.NewRequest("POST", "https://console.example/api", nil)
	r.Header.Set("Origin", "https://evil.example")
	if originOK(r) {
		t.Fatal("cross-origin accepted")
	}
	r.Header.Set("Origin", "https://console.example")
	if !originOK(r) {
		t.Fatal("same-origin rejected")
	}
}

func TestPluginSchemaDefaultsAndSecretSafeErrors(t *testing.T) {
	schema := clone(Object{"type": "object", "properties": Object{"rate": Object{"type": "number", "exclusiveMinimum": 0}, "policy": Object{"type": "string", "default": "local"}, "secret": Object{"type": "string", "minLength": 40}}, "required": []any{"rate"}, "if": Object{"properties": Object{"policy": Object{"enum": []any{"redis"}}}}, "then": Object{"required": []any{"redis_host"}}})
	valid := Object{"rate": 10}
	if err := validatePluginSchema(schema, valid); err != nil {
		t.Fatal(err)
	}
	if _, exists := valid["policy"]; exists {
		t.Fatal("validation mutated original draft")
	}
	for _, invalid := range []Object{{"rate": -1}, {"rate": 10, "policy": "redis"}, {"rate": 10, "secret": "never-echo-this-secret"}} {
		err := validatePluginSchema(schema, invalid)
		if err == nil {
			t.Fatal("invalid plugin accepted")
		}
		if strings.Contains(err.Error(), "never-echo-this-secret") {
			t.Fatal("validation error exposed secret")
		}
	}
}

func TestPluginSchemaCannotLoadExternalResources(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; fmt.Fprint(w, `{}`) }))
	defer server.Close()
	if err := validatePluginSchema(Object{"$ref": server.URL}, Object{}); err == nil || called {
		t.Fatal("external schema was loaded or accepted")
	}
}

func TestHeaderSecretsAndHashSelectors(t *testing.T) {
	value := Object{"key": "remote_addr", "plugins": Object{"proxy-rewrite": Object{"headers": Object{"set": Object{"Authorization": "private-value", "X-API-Key": "another-private", "X-Request-ID": "public-id"}}}}}
	masked := redact(value)
	encoded, _ := json.Marshal(masked)
	if masked["key"] != "remote_addr" || strings.Contains(string(encoded), "private") || !strings.Contains(string(encoded), "public-id") {
		t.Fatal("incorrect redaction")
	}
}

func TestEntityValidationAlsoChecksInstalledPluginSchema(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apisix/admin/schema/validate/routes":
			w.WriteHeader(200)
		case "/apisix/admin/plugins/list":
			fmt.Fprint(w, `["limit-req"]`)
		case "/apisix/admin/plugins/limit-req":
			fmt.Fprint(w, `{"type":"object","properties":{"rate":{"type":"number","exclusiveMinimum":0}},"required":["rate"]}`)
		default:
			t.Error("unexpected request", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	g, _ := NewGateway(server.URL, "key")
	if err := g.Validate(context.Background(), "routes", clone(Object{"uri": "/", "plugins": Object{"limit-req": Object{"rate": -1}}})); err == nil {
		t.Fatal("entity-only validation accepted invalid plugin")
	}
}
