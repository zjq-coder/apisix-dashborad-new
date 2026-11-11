package console

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSchemaSecretsAcrossSnapshots(t *testing.T) {
	var schema Object
	err := json.Unmarshal([]byte(`{"$defs":{"item":{"oneOf":[{"properties":{"a/b":{"writeOnly":true}}},{"encrypt_fields":["alias"],"properties":{"alias":{"type":"string"}}}]}},"properties":{"records":{"type":"array","items":{"$ref":"#/$defs/item"}},"byName":{"additionalProperties":{"format":"password"}},"codes":{"items":{"format":"password"}},"literal.name":{"writeOnly":true}}}`), &schema)
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{}
	for _, p := range schemaSecretPointers(schema) {
		paths = append(paths, "/plugins/custom"+p)
	}
	value := clone(Object{"plugins": Object{"custom": Object{"records": []any{Object{"a/b": "canary-alpha", "title": "public-title"}, Object{"alias": "canary-bravo"}}, "byName": Object{"a.b": "canary-charlie"}, "codes": []any{"canary-delta"}, "literal.name": "canary-echo"}}})
	for _, surface := range []any{redact(value, paths), publicDraft(Draft{Before: value, After: value, SensitivePaths: paths}), publicChange(Change{Operations: []Operation{{Before: nil, After: value, ActualAfter: value, SensitivePaths: paths}}}), differences(value, nil, paths)} {
		b, _ := json.Marshal(surface)
		if strings.Contains(string(b), "canary-") || !strings.Contains(string(b), "public-title") {
			t.Fatal("sensitive data escaped or a public sibling was lost")
		}
	}
	resolved, e := restoreSecrets(redact(value, paths), value)
	if e != nil || hash(Object(resolved.(map[string]any))) != hash(value) {
		t.Fatal("preserving masked credentials changed the source")
	}
}
func TestSchemaSecretReferencesFailClosed(t *testing.T) {
	var s Object
	_ = json.Unmarshal([]byte(`{"properties":{"deep":{"$ref":"#/$defs/node"},"other":{"$ref":"#/$defs/missing"}},"$defs":{"node":{"properties":{"child":{"$ref":"#/$defs/node"}}}}}`), &s)
	paths := secretPathSet(schemaSecretPointers(s))
	if !paths["/deep/child"] || !paths["/other"] {
		t.Fatal("an unresolved schema subtree was exposed")
	}
}
func TestLoginLimitDoesNotPenalizeSuccessfulSignIns(t *testing.T) {
	s := &Server{loginAttempts: map[string][]time.Time{}}
	for i := 0; i < 14; i++ {
		v, ok := s.reserveLogin("local")
		if !ok {
			t.Fatal("successful logins exhausted a shared address")
		}
		s.releaseLogin("local", v)
	}
	for i := 0; i < 8; i++ {
		if _, ok := s.reserveLogin("local"); !ok {
			t.Fatal("reservation rejected too early")
		}
	}
	if _, ok := s.reserveLogin("local"); ok {
		t.Fatal("failed or concurrent attempts did not exhaust budget")
	}
	if _, ok := s.reserveLogin("other"); !ok {
		t.Fatal("unrelated address blocked")
	}
}

func TestMutationsRequireDurableAudit(t *testing.T) {
	db, err := sql.Open("pgx", "")
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	s := &Server{Store: &Store{DB: db}}
	req := httptest.NewRequest("POST", "/api/v1/users", nil)
	ctx := context.WithValue(req.Context(), principalKey{}, principal{Username: "operator", Role: "administrator"})
	req = req.WithContext(context.WithValue(ctx, auditContextKey{}, &auditEntry{who: "operator", action: "account.create"}))
	w := httptest.NewRecorder()
	called := false
	s.authorize("admin", func(http.ResponseWriter, *http.Request) { called = true })(w, req)
	if called || w.Code != 503 {
		t.Fatal("a mutation passed without reserving its audit entry")
	}
}
func TestLegacySnapshotsAndUnexpectedReadbackAreMasked(t *testing.T) {
	old := DraftPayload{After: clone(Object{"plugins": Object{"old-plugin": Object{"unclassified": "old-canary"}}})}
	live := clone(Object{"plugins": Object{"unexpected": Object{"nonstandard": "readback-canary"}}})
	for _, surface := range []any{publicDraft(Draft{After: old.After, SensitivePaths: old.protectedPaths()}), publicChange(Change{Operations: []Operation{{After: old.After, SensitivePaths: old.protectedPaths(), ActualAfter: live}}}), publicChange(Change{Operations: []Operation{{ActualAfter: live}}})} {
		b, _ := json.Marshal(surface)
		if strings.Contains(string(b), "canary") {
			t.Fatal("legacy or unplanned value exposed")
		}
	}
}
