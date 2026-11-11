package console

import "net/http"

// Validate against the gateway without executing or persisting the plugin.
func (s *Server) validatePlugin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Value        Object `json:"value"`
		ResourceID   string `json:"resource_id"`
		DraftID      string `json:"draft_id"`
		ResourceType string `json:"resource_type"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Value == nil {
		fail(w, 400, "插件配置必须是对象")
		return
	}
	clusterID, plugin := r.PathValue("cluster"), r.PathValue("plugin")
	if in.ResourceType == "" {
		in.ResourceType = "routes"
	}
	if !pluginEditorKind(in.ResourceType) || !idPattern.MatchString(plugin) {
		fail(w, 400, "插件配置上下文不正确")
		return
	}
	_, g, err := s.gateway(r.Context(), clusterID)
	if err != nil {
		dbError(w, err)
		return
	}
	var base Object
	if in.DraftID != "" {
		if !needDraft(w, r, s.Store.DB, in.DraftID, "view") {
			return
		}
		d, err := s.Store.Draft(r.Context(), in.DraftID)
		if err != nil {
			dbError(w, err)
			return
		}
		if d.ClusterID != clusterID || d.ResourceType != in.ResourceType || (in.ResourceID != "" && d.ResourceID != in.ResourceID) {
			fail(w, 400, "草稿不属于当前集群的目标资源")
			return
		}
		base = d.After
	} else if in.ResourceID != "" {
		if !resourceIDOK(in.ResourceType, in.ResourceID) {
			fail(w, 400, "资源标识不正确")
			return
		}
		base, err = g.Get(r.Context(), in.ResourceType, in.ResourceID)
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
	}
	var previous any
	if plugins, ok := base["plugins"].(map[string]any); ok {
		previous = plugins[plugin]
	}
	resolved, err := restoreSecrets(in.Value, previous)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	candidate := Object{"uri": "/__dashboard_plugin_validation__", "plugins": Object{plugin: resolved}}
	scope := "routes"
	if in.ResourceType == "consumers" || in.ResourceType == "credentials" {
		scope = "consumers"
		candidate = Object{"username": "__dashboard_plugin_validation__", "plugins": Object{plugin: resolved}}
	}
	err = g.Validate(r.Context(), scope, candidate)
	if err != nil {
		fail(w, 422, err.Error())
		return
	}
	reply(w, 200, Object{"ok": true})
}

func pluginEditorKind(kind string) bool {
	switch kind {
	case "routes", "services", "plugin_configs", "global_rules", "consumer_groups", "consumers", "credentials":
		return true
	}
	return false
}
