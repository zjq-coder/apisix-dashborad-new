package console

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"
)

type Object map[string]any

const KeepSecret = "${dashboard:keep-secret}"

type Cluster struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Environment string     `json:"environment"`
	URL         string     `json:"url"`
	Description string     `json:"description"`
	ReadOnly    bool       `json:"read_only"`
	Version     string     `json:"version"`
	Status      string     `json:"status"`
	LastChecked *time.Time `json:"last_checked"`
	CreatedAt   time.Time  `json:"created_at"`
	KeyCipher   string     `json:"-"`
}

type Resource struct {
	ID            string `json:"id"`
	Value         Object `json:"value"`
	Hash          string `json:"hash"`
	ModifiedIndex int64  `json:"modified_index"`
}

type DraftPayload struct {
	SecretPolicyVersion int      `json:"secret_policy_version,omitempty"`
	Before              Object   `json:"before"`
	After               Object   `json:"after"`
	SensitivePaths      []string `json:"sensitive_paths,omitempty"`
}

type Draft struct {
	SensitivePaths []string     `json:"-"`
	ID             string       `json:"id"`
	ClusterID      string       `json:"cluster_id"`
	ResourceType   string       `json:"resource_type"`
	ResourceID     string       `json:"resource_id"`
	Action         string       `json:"action"`
	Title          string       `json:"title"`
	Status         string       `json:"status"`
	BaseHash       string       `json:"base_hash"`
	Revision       int          `json:"revision"`
	CreatedBy      string       `json:"created_by"`
	CreatedAt      time.Time    `json:"created_at"`
	UpdatedAt      time.Time    `json:"updated_at"`
	Before         Object       `json:"before"`
	After          Object       `json:"after"`
	Diff           []Difference `json:"diff"`
}

type Difference struct {
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Before    any    `json:"before"`
	After     any    `json:"after"`
	Sensitive bool   `json:"sensitive"`
}

type Check struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

type Change struct {
	ID         string      `json:"id"`
	ClusterID  string      `json:"cluster_id"`
	Title      string      `json:"title"`
	Reason     string      `json:"reason"`
	Status     string      `json:"status"`
	RollbackOf string      `json:"rollback_of"`
	CreatedBy  string      `json:"created_by"`
	CreatedAt  time.Time   `json:"created_at"`
	UpdatedAt  time.Time   `json:"updated_at"`
	Operations []Operation `json:"operations"`
}

type Operation struct {
	SensitivePaths []string     `json:"-"`
	ID             string       `json:"id"`
	DraftID        string       `json:"draft_id"`
	ResourceType   string       `json:"resource_type"`
	ResourceID     string       `json:"resource_id"`
	Action         string       `json:"action"`
	Status         string       `json:"status"`
	BaseHash       string       `json:"base_hash"`
	Error          string       `json:"error"`
	Before         Object       `json:"before"`
	After          Object       `json:"after"`
	ActualAfter    Object       `json:"actual_after"`
	Diff           []Difference `json:"diff"`
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func clone(v Object) Object {
	if v == nil {
		return nil
	}
	b, _ := json.Marshal(v)
	var out Object
	_ = json.Unmarshal(b, &out)
	return out
}
func clean(v Object) Object {
	out := clone(v)
	delete(out, "id")
	delete(out, "create_time")
	delete(out, "update_time")
	return out
}
func hash(v Object) string {
	if v == nil {
		return "absent"
	}
	b, _ := json.Marshal(clean(v))
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func stringValue(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
func resourceTypeOK(t string) bool {
	switch t {
	case "routes", "upstreams", "consumers", "services", "plugin_configs", "global_rules", "plugin_metadata", "stream_routes", "protos", "secrets", "consumer_groups", "credentials":
		return true
	}
	return false
}

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`)
var consumerNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,256}$`)

func resourceIDOK(kind, id string) bool {
	if kind == "credentials" || kind == "secrets" {
		owner, key, ok := strings.Cut(id, ":")
		if !ok || !safeID(key) {
			return false
		}
		if kind == "credentials" {
			return consumerNamePattern.MatchString(owner)
		}
		return owner == "vault" || owner == "aws" || owner == "gcp"
	}
	if kind == "consumers" {
		return consumerNamePattern.MatchString(id)
	}
	return safeID(id)
}

func safeID(id string) bool { return id != "." && id != ".." && idPattern.MatchString(id) }

// Consumers are addressed by username, including when PUT uses the collection endpoint.
func checkResourceIdentity(kind, id string, value Object) error {
	if kind == "consumers" && value != nil && (!consumerNamePattern.MatchString(stringValue(value["username"])) || (id != "" && value["username"] != id)) {
		return fmt.Errorf("消费者用户名须为 1–256 位字母、数字、下划线或短横线，并与目标资源标识一致")
	}
	return nil
}

func sensitive(path, key string) bool {
	k := strings.ToLower(key)
	k = strings.ReplaceAll(k, "-", "_")
	if k == "passphrase" || k == "privatekey" || k == "clientkey" || k == "signing_key" || strings.Contains(k, "password") || strings.Contains(k, "secret") || strings.Contains(k, "token") || strings.Contains(k, "private_key") || k == "api_key" || strings.HasSuffix(k, "_api_key") || k == "apikey" || k == "client_key" || k == "access_key" || k == "authorization" || k == "proxy_authorization" || k == "cookie" || k == "set_cookie" {
		return true
	}
	// Top-level upstream key is a hash selector, not a credential.
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if k != "key" || len(parts) < 2 || parts[0] != "plugins" {
		return false
	}
	return parts[1] != "limit-req" && parts[1] != "limit-count" && parts[1] != "limit-conn"
}

// Old encrypted snapshots predate schema traversal. Keep their plugin blocks opaque without contacting a live gateway.
func (p DraftPayload) protectedPaths() []string {
	if p.SecretPolicyVersion < 1 {
		return append(p.SensitivePaths, "/plugins/*")
	}
	return p.SensitivePaths
}

func secretPathSet(paths ...[]string) map[string]bool {
	set := map[string]bool{}
	for _, group := range paths {
		for _, path := range group {
			set[path] = true
		}
	}
	return set
}
func maskedPath(paths map[string]bool, path string) bool {
	if paths[path] {
		return true
	}
	var parts []string
	for pattern := range paths {
		if !strings.Contains(pattern, "*") {
			continue
		}
		if parts == nil {
			parts = strings.Split(path, "/")
		}
		want := strings.Split(pattern, "/")
		if len(want) != len(parts) {
			continue
		}
		ok := true
		for i, v := range want {
			if v != "*" && v != parts[i] {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}
func redactValue(v any, path string, policies ...map[string]bool) any {
	policy := map[string]bool{}
	if len(policies) > 0 {
		policy = policies[0]
	}
	if path != "" && v != nil && maskedPath(policy, path) {
		return KeepSecret
	}
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range x {
			if (sensitive(path, k)) && val != nil {
				out[k] = KeepSecret
			} else {
				out[k] = redactValue(val, path+"/"+pointerPart(k), policy)
			}
		}
		return out
	case Object:
		return redactValue(map[string]any(x), path, policy)
	case []any:
		out := make([]any, len(x))
		for i, val := range x {
			out[i] = redactValue(val, fmt.Sprintf("%s/%d", path, i), policy)
		}
		return out
	default:
		return v
	}
}
func redact(v Object, paths ...[]string) Object {
	if v == nil {
		return nil
	}
	return Object(redactValue(v, "", secretPathSet(paths...)).(map[string]any))
}

func restoreSecrets(v any, base any) (any, error) {
	if text, ok := v.(string); ok && text == KeepSecret {
		if base == nil {
			return nil, fmt.Errorf("新字段不能使用保留密钥占位符")
		}
		return base, nil
	}
	switch x := v.(type) {
	case map[string]any:
		b, _ := base.(map[string]any)
		if b == nil {
			if bo, ok := base.(Object); ok {
				b = map[string]any(bo)
			}
		}
		out := map[string]any{}
		for k, val := range x {
			resolved, err := restoreSecrets(val, b[k])
			if err != nil {
				return nil, err
			}
			out[k] = resolved
		}
		return out, nil
	case Object:
		return restoreSecrets(map[string]any(x), base)
	case []any:
		b, _ := base.([]any)
		out := make([]any, len(x))
		for i, val := range x {
			var old any
			if i < len(b) {
				old = b[i]
			}
			resolved, err := restoreSecrets(val, old)
			if err != nil {
				return nil, err
			}
			out[i] = resolved
		}
		return out, nil
	default:
		return v, nil
	}
}

func differences(before, after Object, paths ...[]string) []Difference {
	result := []Difference{}
	policy := secretPathSet(paths...)
	var walk func(string, any, any, bool)
	walk = func(path string, a, b any, private bool) {
		if reflect.DeepEqual(a, b) {
			return
		}
		am, aok := a.(map[string]any)
		bm, bok := b.(map[string]any)
		emptyObjectChange := (a == nil && bok && len(bm) == 0) || (b == nil && aok && len(am) == 0)
		if !private && !emptyObjectChange && (aok || a == nil) && (bok || b == nil) && (aok || bok) {
			keys := map[string]bool{}
			for k := range am {
				keys[k] = true
			}
			for k := range bm {
				keys[k] = true
			}
			order := []string{}
			for k := range keys {
				order = append(order, k)
			}
			sort.Strings(order)
			for _, k := range order {
				child := path + "/" + pointerPart(k)
				walk(child, am[k], bm[k], sensitive(path, k) || maskedPath(policy, child))
			}
			return
		}
		kind := "replace"
		if a == nil {
			kind = "add"
		}
		if b == nil {
			kind = "remove"
		}
		if private {
			if a != nil {
				a = "••••••"
			}
			if b != nil {
				b = "••••••（已更新）"
			}
		} else {
			a = redactValue(a, path, policy)
			b = redactValue(b, path, policy)
		}
		result = append(result, Difference{Path: path, Kind: kind, Before: a, After: b, Sensitive: private})
	}
	var a, b any
	if before != nil {
		a = map[string]any(clean(before))
	}
	if after != nil {
		b = map[string]any(clean(after))
	}
	walk("", a, b, false)
	return result
}

// APISIX adds these documented defaults to stored entities. Other unknown fields remain significant.
func canonicalForWrite(kind string, v Object) Object {
	out := clean(v)
	if out == nil {
		return nil
	}
	defaults := Object{}
	if kind == "routes" {
		defaults = Object{"priority": float64(0), "status": float64(1)}
	}
	if kind == "upstreams" {
		defaults = Object{"type": "roundrobin", "scheme": "http", "pass_host": "pass", "hash_on": "vars"}
	}
	for k, val := range defaults {
		if _, ok := out[k]; !ok {
			out[k] = val
		}
	}
	return out
}

func matchesWrite(kind string, want, got Object) bool {
	if want == nil || got == nil {
		return want == nil && got == nil
	}
	return reflect.DeepEqual(canonicalForWrite(kind, want), canonicalForWrite(kind, got))
}

func publicDraft(d Draft) Draft {
	d.Diff = differences(d.Before, d.After, d.SensitivePaths)
	d.Before = redact(d.Before, d.SensitivePaths)
	d.After = redact(d.After, d.SensitivePaths)
	return d
}
func publicChange(c Change) Change {
	for i := range c.Operations {
		o := &c.Operations[i]
		o.Diff = differences(o.Before, o.After, o.SensitivePaths)
		o.Before = redact(o.Before, o.SensitivePaths)
		o.After = redact(o.After, o.SensitivePaths)
		actualPaths := append([]string(nil), o.SensitivePaths...)
		actual, _ := o.ActualAfter["plugins"].(map[string]any)
		before, _ := o.Before["plugins"].(map[string]any)
		after, _ := o.After["plugins"].(map[string]any)
		for name := range actual {
			if _, was := before[name]; !was {
				if _, planned := after[name]; !planned {
					actualPaths = append(actualPaths, "/plugins/"+pointerPart(name))
				}
			}
		}
		o.ActualAfter = redact(o.ActualAfter, actualPaths)
	}
	return c
}
