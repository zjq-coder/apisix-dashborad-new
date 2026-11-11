package console

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestTransferMapsOnlyTypedReferencesAndRejectsDuplicateNodes(t *testing.T) {
	v := Object{"service_id": "svc", "desc": "svc", "plugins": map[string]any{"grpc-transcode": map[string]any{"proto_id": "proto"}}}
	visitReferences("routes", "r", v, func(ref resourceRef) string { return ref.ID + "2" })
	if v["desc"] != "svc" || v["service_id"] != "svc2" || !reflect.DeepEqual(directRefs("routes", "r", v), []resourceRef{{"services", "svc2"}, {"protos", "proto2"}}) {
		t.Fatal("incorrect ID references")
	}
	if rewriteNetwork(Object{"nodes": map[string]any{"a": 1, "b": 2}}, "upstreams", nil, map[string]string{"b": "a"}) == nil {
		t.Fatal("overlapping addresses accepted")
	}
	for _, value := range []string{KeepSecret, "$env://TARGET", "$secret://vault/test/key"} {
		if !portableSecrets(Object{"token": value}, Object{"token": KeepSecret}) {
			t.Fatal("target reference rejected")
		}
	}
	if portableSecrets(Object{"items": []any{map[string]any{"token": "plain"}}}, Object{"items": []any{map[string]any{"token": KeepSecret}}}) {
		t.Fatal("nested plaintext accepted")
	}
}
func TestCompositeResourceIDs(t *testing.T) {
	for _, r := range []resourceRef{{"secrets", "vault:../bad"}, {"credentials", "u:.."}, {"upstreams", "."}, {"secrets", "other:id"}} {
		if resourceIDOK(r.Kind, r.ID) {
			t.Fatal(r)
		}
	}
	if resourcePath("credentials", "user:key") != "/consumers/user/credentials/key" || resourcePath("secrets", "aws:id") != "/secrets/aws/id" {
		t.Fatal("incorrect nested paths")
	}
}
func TestIsolatedStreamGateway(t *testing.T) {
	if os.Getenv("P1_STREAM_SANDBOX") != "1" {
		t.Skip("requires isolated tests/stream Compose stack")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	g, err := NewGateway("http://gateway:9180", "isolated-stream-fixture")
	if err != nil {
		t.Fatal(err)
	}
	for {
		_, err = g.List(ctx, "stream_routes")
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Second)
	}
	const id = "p1-isolated-stream"
	op := Operation{ResourceType: "stream_routes", ResourceID: id, Action: "create", BaseHash: "absent", After: Object{"server_port": float64(9100), "upstream": map[string]any{"type": "roundrobin", "nodes": map[string]any{"echo:80": float64(1)}}}}
	if checks := preflight(ctx, g, Cluster{}, []Operation{op}); !checksOK(checks) {
		t.Fatal(checks)
	}
	status, actual, msg := applyOperation(ctx, g, op)
	defer g.Delete(ctx, "stream_routes", id)
	if status != "applied" {
		t.Fatalf("stream create %s %s, actual %v", status, msg, actual)
	}
	client := http.Client{Timeout: time.Second}
	forwarded := false
	for i := 0; i < 40; i++ {
		resp, e := client.Get("http://gateway:9100/")
		if e == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				forwarded = true
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !forwarded {
		t.Fatal("TCP listener did not forward to nginx")
	}
	op.After = nil
	op.Before = actual
	op.BaseHash = hash(actual)
	op.Action = "delete"
	if status, _, msg := applyOperation(ctx, g, op); status != "applied" {
		t.Fatal(msg)
	}
	if v, err := g.Get(ctx, "stream_routes", id); v != nil || err != nil {
		t.Fatal("stream rollback readback", err)
	}
}

func TestCredentialAndSecretDependencies(t *testing.T) {
	v := Object{"plugins": map[string]any{"key-auth": map[string]any{"key": "$secret://vault/manager/private-lookup"}}}
	refs := directRefs("credentials", "user:daily", v)
	if len(refs) != 2 || refs[0] != (resourceRef{"secrets", "vault:manager"}) || refs[1] != (resourceRef{"consumers", "user"}) {
		t.Fatal("incorrect dependencies")
	}
}

func TestNetworkMappingsPreserveNodeWeightsAndUnrelatedText(t *testing.T) {
	v := Object{"hosts": []any{"dev.example", "other.example"}, "desc": "dev.example", "upstream": map[string]any{"nodes": []any{map[string]any{"host": "::1", "port": float64(80), "weight": float64(4)}}}}
	err := rewriteNetwork(v, "routes", map[string]string{"dev.example": "stage.example"}, map[string]string{"[::1]:80": "stage:8080"})
	if err != nil {
		t.Fatal(err)
	}
	node := v["upstream"].(map[string]any)["nodes"].([]any)[0].(map[string]any)
	if !reflect.DeepEqual(v["hosts"], []any{"stage.example", "other.example"}) || v["desc"] != "dev.example" || node["host"] != "stage" || node["port"] != 8080 || node["weight"] != float64(4) {
		t.Fatal(v)
	}
}
func TestSensitiveFieldsUseMetadataAndStreamSchemas(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		schema := Object{"type": "object", "properties": Object{"opaque": Object{"writeOnly": true, "type": "string"}}}
		switch {
		case r.URL.Path == "/apisix/admin/plugins" && r.URL.Query().Get("all") == "true":
			json.NewEncoder(w).Encode(Object{"sample": Object{"schema": Object{}, "metadata_schema": schema}})
		case r.URL.Path == "/apisix/admin/plugins/sample" && r.URL.Query().Get("subsystem") == "stream":
			json.NewEncoder(w).Encode(schema)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	g, err := NewGateway(srv.URL, "test")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		kind, id string
		value    Object
		want     string
	}{
		{"plugin_metadata", "sample", Object{"opaque": "private"}, "/opaque"},
		{"plugin_metadata", "no-metadata-schema", Object{"opaque": "private"}, "/*"},
		{"stream_routes", "r", Object{"plugins": map[string]any{"sample": map[string]any{"opaque": "private"}}}, "/plugins/sample/opaque"},
	} {
		paths, err := g.ResourceSecretPaths(context.Background(), test.kind, test.id, test.value)
		if err != nil || !reflect.DeepEqual(paths, []string{test.want}) {
			t.Fatal(test.kind, paths, err)
		}
	}
}
