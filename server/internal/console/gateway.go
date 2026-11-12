package console

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Gateway interface {
	List(context.Context, string) ([]Resource, error)
	Get(context.Context, string, string) (Object, error)
	Put(context.Context, string, string, Object) error
	Delete(context.Context, string, string) error
	Validate(context.Context, string, Object) error
	Plugins(context.Context) ([]string, error)
	PluginSchema(context.Context, string) (Object, error)
}

type APIError struct {
	Status int
	Method string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("APISIX %s 返回 HTTP %d；请检查目标集群权限、资源引用与配置参数", e.Method, e.Status)
}
func isNotFound(err error) bool { var api *APIError; return errors.As(err, &api) && api.Status == 404 }

type HTTPGateway struct {
	BaseURL, Key string
	Client       *http.Client
	Version      string
	schemas      sync.Map
}

func normalizeURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Hostname() == "" || !(u.Scheme == "http" || u.Scheme == "https") {
		return "", fmt.Errorf("请填写完整的 HTTP 或 HTTPS Admin API 地址")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("集群地址不能包含用户凭据、查询参数或片段")
	}
	path := strings.TrimRight(u.Path, "/")
	if path != "" && path != "/apisix/admin" {
		return "", fmt.Errorf("地址路径应为空或 /apisix/admin")
	}
	u.Path = "/apisix/admin"
	return u.String(), nil
}
func NewGateway(raw, key string) (*HTTPGateway, error) {
	base, err := normalizeURL(raw)
	if err != nil {
		return nil, err
	}
	return &HTTPGateway{BaseURL: base, Key: key, Client: &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return fmt.Errorf("Admin API 重定向已拒绝") }}}, nil
}

var versionPattern = regexp.MustCompile(`(?i)apisix/([0-9.]+)`)

func (g *HTTPGateway) request(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, g.BaseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("X-API-KEY", g.Key)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := g.Client.Do(req)
	if err != nil {
		return fmt.Errorf("无法连接 Admin API，请检查网络、地址和 TLS 证书")
	}
	defer resp.Body.Close()
	if match := versionPattern.FindStringSubmatch(resp.Header.Get("Server")); len(match) > 1 {
		g.Version = match[1]
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode == 400 && strings.HasPrefix(path, "/stream_routes") {
			data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			if strings.Contains(string(data), "stream mode is disabled") {
				return errStreamDisabled
			}
		}
		return &APIError{Status: resp.StatusCode, Method: method}
	}
	if out == nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return fmt.Errorf("读取 APISIX 响应失败")
	}
	if len(data) == 0 {
		return nil
	}
	if err = json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("Admin API 返回非 JSON 响应，请检查接入地址")
	}
	return nil
}
func resourceFromNode(node Object, kind string) Resource {
	value, _ := node["value"].(map[string]any)
	id := stringValue(value["id"])
	if kind == "consumers" {
		id = stringValue(value["username"])
	}
	if id == "" {
		parts := strings.Split(stringValue(node["key"]), "/")
		id = parts[len(parts)-1]
	}
	index, _ := node["modifiedIndex"].(float64)
	return Resource{ID: id, Value: Object(value), Hash: hash(Object(value)), ModifiedIndex: int64(index)}
}
func (g *HTTPGateway) List(ctx context.Context, kind string) ([]Resource, error) {
	return g.listAt(ctx, kind, "/"+kind)
}
func (g *HTTPGateway) listCredentials(ctx context.Context, owner string) ([]Resource, error) {
	items, err := g.listAt(ctx, "credentials", "/consumers/"+url.PathEscape(owner)+"/credentials")
	for i := range items {
		items[i].ID = owner + ":" + items[i].ID
	}
	return items, err
}
func (g *HTTPGateway) listAt(ctx context.Context, kind, collection string) ([]Resource, error) {
	out := []Resource{}
	seen := map[string]bool{}
	for page := 1; page <= 200; page++ {
		var envelope Object
		path := collection + "?page=" + strconv.Itoa(page) + "&page_size=500"
		if err := g.request(ctx, "GET", path, nil, &envelope); err != nil {
			return nil, err
		}
		list, ok := envelope["list"].([]any)
		if !ok {
			// Lua cjson represents an empty table as {} on some APISIX 3.x builds.
			empty, isObject := envelope["list"].(map[string]any)
			total, hasTotal := envelope["total"].(float64)
			if isObject && len(empty) == 0 && hasTotal && total == 0 {
				return out, nil
			}
			return nil, fmt.Errorf("目标版本的资源列表格式尚未支持")
		}
		added := 0
		for _, item := range list {
			node, ok := item.(map[string]any)
			if !ok {
				continue
			}
			r := resourceFromNode(node, kind)
			if kind == "consumers" && strings.Contains(stringValue(node["key"]), "/credentials/") {
				raw := stringValue(node["key"])
				if !seen[raw] {
					seen[raw] = true
					added++
				}
				continue
			}
			if kind == "secrets" {
				fields := strings.Split(stringValue(node["key"]), "/")
				if len(fields) >= 2 {
					r.ID = fields[len(fields)-2] + ":" + fields[len(fields)-1]
				}
			}
			if kind == "credentials" {
				fields := strings.Split(stringValue(node["key"]), "/")
				r.ID = fields[len(fields)-1]
			}
			if r.ID != "" && !seen[r.ID] {
				seen[r.ID] = true
				out = append(out, r)
				added++
			}
		}
		total, _ := envelope["total"].(float64)
		if len(list) < 500 || (total > 0 && len(seen) >= int(total)) {
			return out, nil
		}
		if added == 0 {
			return nil, fmt.Errorf("分页返回重复数据，请检查 APISIX 版本支持")
		}
	}
	return nil, fmt.Errorf("资源数量超过当前同步上限")
}
func (g *HTTPGateway) Get(ctx context.Context, kind, id string) (Object, error) {
	var out Object
	err := g.request(ctx, "GET", resourcePath(kind, id), nil, &out)
	if isNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	value, ok := out["value"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("资源响应格式不支持")
	}
	return Object(value), nil
}
func (g *HTTPGateway) Put(ctx context.Context, kind, id string, value Object) error {
	if err := checkResourceIdentity(kind, id, value); err != nil {
		return err
	}
	if kind == "consumers" {
		return g.request(ctx, "PUT", "/consumers", clean(value), nil)
	}
	return g.request(ctx, "PUT", resourcePath(kind, id), clean(value), nil)
}
func resourcePath(kind, id string) string {
	owner, key, _ := strings.Cut(id, ":")
	if kind == "credentials" {
		return "/consumers/" + url.PathEscape(owner) + "/credentials/" + url.PathEscape(key)
	}
	if kind == "secrets" {
		return "/secrets/" + url.PathEscape(owner) + "/" + url.PathEscape(key)
	}
	return "/" + kind + "/" + url.PathEscape(id)
}
func (g *HTTPGateway) Delete(ctx context.Context, kind, id string) error {
	err := g.request(ctx, "DELETE", resourcePath(kind, id), nil, nil)
	if isNotFound(err) {
		return nil
	}
	return err
}
func (g *HTTPGateway) Validate(ctx context.Context, kind string, value Object) error {
	if value == nil {
		return nil
	}
	if kind == "routes" {
		if err := validateRouteExpressions(value); err != nil {
			return err
		}
	}
	if err := g.request(ctx, "POST", "/schema/validate/"+kind, clean(value), nil); err != nil {
		return err
	}
	if kind == "routes" || kind == "services" || kind == "global_rules" || kind == "plugin_configs" || kind == "consumer_groups" {
		return validateRoutePlugins(ctx, g, value)
	}
	if kind == "consumers" || kind == "credentials" {
		return g.validateConsumerPlugins(ctx, value)
	}
	return nil
}
func (g *HTTPGateway) Plugins(ctx context.Context) ([]string, error) {
	var out []string
	err := g.request(ctx, "GET", "/plugins/list", nil, &out)
	if out == nil {
		out = []string{}
	}
	return out, err
}
func (g *HTTPGateway) PluginSchema(ctx context.Context, name string) (Object, error) {
	if cached, ok := g.schemas.Load("route/" + name); ok {
		return clone(cached.(Object)), nil
	}
	var out Object
	err := g.request(ctx, "GET", "/plugins/"+url.PathEscape(name), nil, &out)
	if schema, ok := out["schema"].(map[string]any); ok {
		out = Object(schema)
	}
	if err == nil {
		normalizePluginSchema(out)
		g.schemas.Store("route/"+name, clone(out))
	}
	return out, err
}
