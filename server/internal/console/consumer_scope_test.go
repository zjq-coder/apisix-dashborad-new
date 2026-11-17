package console

import "testing"

func TestSplitCredentialKeepsIdentityPoliciesAndSeparatesSecrets(t *testing.T) {
	catalog := []PluginDefinition{
		{Name: "key-auth", Type: "auth", ConsumerSource: "dedicated", CanScopeCredential: true},
		{Name: "basic-auth", Type: "auth", ConsumerSource: "dedicated", CanScopeCredential: true},
		{Name: "custom-auth", Type: "auth", ConsumerSource: "none"},
		{Name: "consumer-restriction", ConsumerSource: "none"},
		{Name: "limit-count", ConsumerSource: "none"},
	}
	source := Object{"username": "alice", "id": "alice", "create_time": 10, "group_id": "team",
		"labels": Object{"tenant": "demo"},
		"plugins": Object{"key-auth": Object{"key": "fixture"}, "basic-auth": Object{"password": "p"},
			"custom-auth": Object{}, "limit-count": Object{"count": 30},
			"consumer-restriction": Object{"blacklist": []string{"previous"}}}}
	beforeHash := hash(source)
	left, right, err := splitCredential(source, "alice-key", "key-auth", "route_id", []string{"orders"}, catalog)
	if err != nil {
		t.Fatal(err)
	}
	leftPlugins := left["plugins"].(map[string]any)
	rightPlugins := right["plugins"].(map[string]any)
	if beforeHash != hash(source) || left["username"] != "alice" || leftPlugins["key-auth"] != nil ||
		leftPlugins["basic-auth"] == nil || leftPlugins["custom-auth"] == nil ||
		leftPlugins["consumer-restriction"].(map[string]any)["blacklist"] == nil {
		t.Fatal("source edit changed more than the selected credential")
	}
	if right["username"] != "alice-key" || right["group_id"] != "team" || right["labels"] == nil ||
		right["id"] != nil || right["create_time"] != nil || rightPlugins["limit-count"] == nil ||
		rightPlugins["key-auth"].(map[string]any)["key"] != "fixture" ||
		rightPlugins["custom-auth"] != nil || rightPlugins["basic-auth"] != nil ||
		rightPlugins["consumer-restriction"].(Object)["type"] != "route_id" {
		t.Fatal("target must contain only the selected credential and the intended policies")
	}
	for _, method := range []string{"limit-count", "absent"} {
		if _, _, err = splitCredential(source, "alice-key", method, "route_id", []string{"orders"}, catalog); err == nil {
			t.Fatalf("accepted invalid credential %s", method)
		}
	}
	if _, _, err = splitCredential(source, "alice-key", "key-auth", "route_id", []string{"orders"}, catalog[:3]); err == nil {
		t.Fatal("accepted gateway without consumer-restriction")
	}
	if _, _, err = splitCredential(source, "alice-key", "key-auth", "route_id", []string{"orders"}, catalog[:4]); err == nil {
		t.Fatal("copied unidentified consumer plugin")
	}
}
