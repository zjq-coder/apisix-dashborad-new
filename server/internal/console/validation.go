package console

import "net/http"

// Validate an unsaved editor snapshot without creating a draft or writing to APISIX.
func (s *Server) validateConfig(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ResourceType string `json:"resource_type"`
		ResourceID   string `json:"resource_id"`
		DraftID      string `json:"draft_id"`
		IncludeDiff  bool   `json:"include_diff"`
		Value        Object `json:"value"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if !resourceTypeOK(in.ResourceType) || in.Value == nil || (in.ResourceID != "" && !resourceIDOK(in.ResourceType, in.ResourceID)) {
		fail(w, 400, "资源类型、ID 或配置对象不正确")
		return
	}
	if err := checkResourceIdentity(in.ResourceType, in.ResourceID, in.Value); err != nil {
		fail(w, 400, err.Error())
		return
	}
	clusterID := r.PathValue("cluster")
	_, g, err := s.gateway(r.Context(), clusterID)
	if err != nil {
		dbError(w, err)
		return
	}
	var base, before Object
	var paths []string
	if in.DraftID != "" {
		if !needDraft(w, r, s.Store.DB, in.DraftID, "view") {
			return
		}
		draft, err := s.Store.Draft(r.Context(), in.DraftID)
		if err != nil {
			dbError(w, err)
			return
		}
		if draft.ClusterID != clusterID || draft.ResourceType != in.ResourceType || draft.ResourceID != in.ResourceID {
			fail(w, 400, "草稿不属于当前集群的目标资源")
			return
		}
		base, before = draft.After, draft.Before
		paths = draft.SensitivePaths
	} else if in.ResourceID != "" {
		base, err = g.Get(r.Context(), in.ResourceType, in.ResourceID)
		before = base
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
	}
	resolved, err := restoreSecrets(in.Value, base)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	value := clean(Object(resolved.(map[string]any)))
	checks := []Check{}
	err = validateTarget(r.Context(), g, in.ResourceType, in.ResourceID, value)
	message := "目标网关 Schema 与插件配置校验通过"
	if err != nil {
		message = err.Error()
	}
	checks = append(checks, Check{Name: "配置 Schema", OK: err == nil, Message: message})
	if err == nil {
		id := in.ResourceID
		if id == "" {
			id = "__dashboard_preview__"
		}
		err = checkReferences(r.Context(), g, []Operation{{ResourceType: in.ResourceType, ResourceID: id, Action: "update", After: value}})
		message = "所引用的资源已存在；发布时会再次检查依赖与版本"
		if err != nil {
			message = err.Error()
		}
		checks = append(checks, Check{Name: "资源引用", OK: err == nil, Message: message})
	}
	auditCheck(r, checksOK(checks))
	result := Object{"ok": checksOK(checks), "checks": checks}
	if in.IncludeDiff && checksOK(checks) {
		secretPaths, err := g.ResourceSecretPaths(r.Context(), in.ResourceType, in.ResourceID, before, value)
		if err != nil {
			fail(w, 502, "无法读取插件敏感字段定义")
			return
		}
		protected := append(paths, secretPaths...)
		result["preview"] = Object{"before": redact(before, protected), "after": redact(value, protected), "diff": differences(before, value, protected)}
	}
	reply(w, 200, result)
}
