package console

import (
	"fmt"
	"net/http"
)

// APISIX applies consumer-restriction to an identity. Move one inline authentication
// configuration into its own identity when the other credentials need a different scope.
func (s *Server) scopeCredential(w http.ResponseWriter, r *http.Request) {
	var in struct {
		BaseHash string   `json:"base_hash"`
		Username string   `json:"username"`
		Plugin   string   `json:"plugin"`
		Type     string   `json:"type"`
		Targets  []string `json:"whitelist"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	source := r.PathValue("consumer")
	kind := map[string]string{"route_id": "routes", "service_id": "services"}[in.Type]
	if !resourceIDOK("consumers", source) || !resourceIDOK("consumers", in.Username) || source == in.Username {
		fail(w, 400, "请填写不同于原消费者的有效用户名")
		return
	}
	if kind == "" || len(in.Targets) == 0 {
		fail(w, 400, "请选择允许访问的路由或服务")
		return
	}
	seen := map[string]bool{}
	for _, id := range in.Targets {
		if !resourceIDOK(kind, id) || seen[id] {
			fail(w, 400, "授权目标 ID 无效或重复")
			return
		}
		seen[id] = true
	}
	ctx := r.Context()
	cluster, g, err := s.gateway(ctx, r.PathValue("cluster"))
	if err != nil {
		dbError(w, err)
		return
	}
	if cluster.ReadOnly {
		fail(w, 403, "该集群为只读接入")
		return
	}
	before, err := g.Get(ctx, "consumers", source)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	if before == nil || hash(before) != in.BaseHash {
		fail(w, 409, "网关配置已变化，请刷新资源后重新编辑")
		return
	}
	existing, err := g.Get(ctx, "consumers", in.Username)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	if existing != nil {
		fail(w, 409, "相同 ID 的资源已经存在")
		return
	}
	targets, err := g.List(ctx, kind)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	for _, target := range targets {
		delete(seen, target.ID)
	}
	if len(seen) > 0 {
		fail(w, 409, "授权目标已变化，请刷新后重新选择")
		return
	}
	catalog, err := g.PluginCatalog(ctx)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	remaining, scoped, err := splitCredential(before, in.Username, in.Plugin, in.Type, in.Targets, catalog)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	// Release the old binding first. The change worker compares both baselines,
	// re-reads each write, and records partial application for a possible rollback.
	edits := []Draft{
		{ResourceType: "consumers", ResourceID: source, Action: "update", Before: before, After: remaining, BaseHash: in.BaseHash},
		{ResourceType: "consumers", ResourceID: in.Username, Action: "create", After: scoped, BaseHash: hash(nil)},
	}
	for i := range edits {
		d := &edits[i]
		d.SensitivePaths, err = g.ResourceSecretPaths(ctx, d.ResourceType, d.ResourceID, d.Before, d.After)
		if err != nil {
			fail(w, 502, "无法读取插件敏感字段定义")
			return
		}
	}
	s.submitConfig(w, r, cluster, edits, r.PathValue("mode"))
}

func splitCredential(before Object, username, method, scope string, targets []string, catalog []PluginDefinition) (Object, Object, error) {
	defs := make(map[string]PluginDefinition, len(catalog))
	for _, d := range catalog {
		defs[d.Name] = d
	}
	if _, ok := defs["consumer-restriction"]; !ok {
		return nil, nil, fmt.Errorf("当前集群未启用 consumer-restriction")
	}
	source := clean(before)
	plugins, _ := source["plugins"].(map[string]any)
	auth, ok := defs[method]
	if !ok || auth.ConsumerSource == "none" || plugins[method] == nil {
		return nil, nil, fmt.Errorf("请选择原消费者已配置的内联认证插件")
	}
	if !auth.CanScopeCredential {
		return nil, nil, fmt.Errorf("此插件未确认支持消费者身份绑定，无法单独迁移授权")
	}
	target := clean(before)
	newPlugins := target["plugins"].(map[string]any)
	for name := range newPlugins {
		d, known := defs[name]
		if !known {
			return nil, nil, fmt.Errorf("当前集群无法识别消费者插件 %s", name)
		}
		if name != method && (d.ConsumerSource != "none" || d.Type == "auth") {
			delete(newPlugins, name)
		}
	}
	delete(plugins, method)
	target["username"] = username
	newPlugins["consumer-restriction"] = Object{"type": scope, "whitelist": targets}
	return source, target, nil
}
