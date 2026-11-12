package console

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
	"net/http"
	"strings"
)

func (s *Server) listDrafts(w http.ResponseWriter, r *http.Request) {
	drafts, err := s.Store.Drafts(r.Context(), r.URL.Query().Get("cluster_id"))
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, 200, drafts)
}

func (s *Server) deleteRouteDrafts(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Routes []struct {
			ID   string `json:"id"`
			Hash string `json:"base_hash"`
		} `json:"routes"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.Routes) < 1 || len(in.Routes) > 50 {
		fail(w, 400, "请选择 1 至 50 条路由")
		return
	}
	ctx := r.Context()
	c, g, err := s.gateway(ctx, r.PathValue("cluster"))
	if err != nil {
		dbError(w, err)
		return
	}
	if c.ReadOnly {
		fail(w, 403, "该集群为只读接入")
		return
	}
	drafts := make([]Draft, 0, len(in.Routes))
	seen := map[string]bool{}
	for _, route := range in.Routes {
		if !resourceIDOK("routes", route.ID) || seen[route.ID] {
			fail(w, 400, "路由 ID 无效或重复")
			return
		}
		seen[route.ID] = true
		before, err := g.Get(ctx, "routes", route.ID)
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
		if before == nil || hash(before) != route.Hash {
			fail(w, 409, "网关配置已变化，请刷新资源后重新编辑")
			return
		}
		paths, err := g.ResourceSecretPaths(ctx, "routes", route.ID, before)
		if err != nil {
			fail(w, 502, "无法读取插件敏感字段定义")
			return
		}
		drafts = append(drafts, Draft{ClusterID: c.ID, ResourceType: "routes", ResourceID: route.ID, Action: "delete", Title: route.ID, Before: before, BaseHash: route.Hash, CreatedBy: actor(r), SensitivePaths: paths})
	}
	if mode := r.PathValue("mode"); mode != "" {
		s.submitConfig(w, r, c, drafts, mode)
		return
	}
	s.saveDraftBatch(w, r, c.ID, drafts)
}
func (s *Server) getDraft(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Draft(r.Context(), r.PathValue("draft"))
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, 200, publicDraft(d))
}
func (s *Server) saveDraft(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DraftID      string `json:"draft_id"`
		ClusterID    string `json:"cluster_id"`
		ResourceType string `json:"resource_type"`
		ResourceID   string `json:"resource_id"`
		Action       string `json:"action"`
		Title        string `json:"title"`
		BaseHash     string `json:"base_hash"`
		Revision     int    `json:"revision"`
		Value        Object `json:"value"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	mode := r.PathValue("mode")
	if mode != "" {
		if in.ClusterID != "" && in.ClusterID != r.PathValue("cluster") {
			fail(w, 400, "目标集群不一致")
			return
		}
		in.ClusterID = r.PathValue("cluster")
	}
	if !needCluster(w, r, s.Store.DB, in.ClusterID, "edit") || !s.startAudit(w, r) {
		return
	}
	if !resourceTypeOK(in.ResourceType) || !resourceIDOK(in.ResourceType, in.ResourceID) {
		fail(w, 400, "资源类型或标识格式不正确")
		return
	}
	if in.Action != "create" && in.Action != "update" && in.Action != "delete" {
		fail(w, 400, "变更动作不正确")
		return
	}
	if in.Action != "delete" && in.Value == nil {
		fail(w, 400, "请提供完整配置对象")
		return
	}
	if in.Action != "delete" && len(in.Value) == 0 {
		fail(w, 400, "配置不能为空")
		return
	}
	if in.Action != "delete" {
		if err := checkResourceIdentity(in.ResourceType, in.ResourceID, in.Value); err != nil {
			fail(w, 400, err.Error())
			return
		}
	}
	if len(in.Title) > 200 {
		fail(w, 400, "草稿标题过长")
		return
	}
	if strings.TrimSpace(in.Title) == "" {
		in.Title = stringValue(in.Value["name"])
		if in.Title == "" {
			in.Title = in.ResourceID
		}
	}
	c, g, err := s.gateway(r.Context(), in.ClusterID)
	if err != nil {
		dbError(w, err)
		return
	}
	if c.ReadOnly {
		fail(w, 403, "该集群为只读接入")
		return
	}
	id := r.PathValue("draft")
	if mode != "" {
		id = in.DraftID
	}
	var d Draft
	if id != "" {
		if !needDraft(w, r, s.Store.DB, id, "edit") {
			return
		}
		d, err = s.Store.Draft(r.Context(), id)
		if err != nil {
			dbError(w, err)
			return
		}
		if d.Status != "draft" || d.Revision != in.Revision {
			fail(w, 409, "草稿已被修改或提交，请刷新后重试")
			return
		}
		if d.ClusterID != in.ClusterID || d.ResourceType != in.ResourceType || d.ResourceID != in.ResourceID || d.Action != in.Action {
			fail(w, 400, "已保存草稿的目标资源和动作不可变更")
			return
		}
	} else {
		current, err := g.Get(r.Context(), in.ResourceType, in.ResourceID)
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
		if in.Action == "create" && current != nil {
			fail(w, 409, "相同 ID 的资源已经存在")
			return
		}
		if in.Action != "create" && (current == nil || in.BaseHash != hash(current)) {
			fail(w, 409, "网关配置已变化，请刷新资源后重新编辑")
			return
		}
		d = Draft{ID: newID(), ClusterID: in.ClusterID, ResourceType: in.ResourceType, ResourceID: in.ResourceID, Action: in.Action, Status: "draft", BaseHash: hash(current), Before: current, CreatedBy: actor(r)}
	}
	d.Title = in.Title
	secretBase := d.Before
	if id != "" {
		secretBase = d.After
	}
	d.After = nil
	if in.Action != "delete" {
		resolved, err := restoreSecrets(in.Value, secretBase)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		d.After = clean(Object(resolved.(map[string]any)))
	}
	if in.Action == "update" && len(differences(d.Before, d.After)) == 0 {
		fail(w, 400, "配置没有变化")
		return
	}
	paths, err := g.ResourceSecretPaths(r.Context(), d.ResourceType, d.ResourceID, d.Before, d.After)
	if err != nil {
		fail(w, 502, "无法读取插件敏感字段定义")
		return
	}
	d.SensitivePaths = append(d.SensitivePaths, paths...)
	if mode != "" {
		if id == "" {
			d.ID = ""
		}
		s.submitConfig(w, r, c, []Draft{d}, mode)
		return
	}
	if id == "" {
		err = s.Store.InsertDraft(r.Context(), d)
	} else {
		var blob string
		blob, err = s.Store.Vault.Seal(DraftPayload{SecretPolicyVersion: 1, Before: d.Before, After: d.After, SensitivePaths: d.SensitivePaths})
		if err == nil {
			result, e := s.Store.DB.ExecContext(r.Context(), `UPDATE drafts SET title=$2,payload_cipher=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$4 AND status='draft'`, id, d.Title, blob, in.Revision)
			err = e
			if e == nil {
				n, _ := result.RowsAffected()
				if n == 0 {
					fail(w, 409, "草稿已被另一位用户修改")
					return
				}
			}
		}
	}
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			fail(w, 409, "这个资源已有未提交草稿，请到草稿箱继续编辑")
			return
		}
		dbError(w, err)
		return
	}
	markAudit(r, d.ClusterID, d.ID, d.ResourceType)
	d, err = s.Store.Draft(r.Context(), d.ID)
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, 200, publicDraft(d))
}
func (s *Server) discardDraft(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("draft")
	result, err := s.Store.DB.ExecContext(r.Context(), `UPDATE drafts SET status='discarded',updated_at=now() WHERE id=$1 AND status='draft'`, id)
	if err != nil {
		dbError(w, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		fail(w, 409, "只有未提交的草稿可以丢弃")
		return
	}

	reply(w, 200, Object{"ok": true})
}
func (s *Server) validateDraft(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Draft(r.Context(), r.PathValue("draft"))
	if err != nil {
		dbError(w, err)
		return
	}
	c, g, err := s.gateway(r.Context(), d.ClusterID)
	if err != nil {
		dbError(w, err)
		return
	}
	checks := preflight(r.Context(), g, c, []Operation{{ResourceType: d.ResourceType, ResourceID: d.ResourceID, Action: d.Action, BaseHash: d.BaseHash, Before: d.Before, After: d.After}})
	auditCheck(r, checksOK(checks))
	reply(w, 200, Object{"ok": checksOK(checks), "checks": checks})
}
func checksOK(checks []Check) bool {
	for _, c := range checks {
		if !c.OK {
			return false
		}
	}
	return true
}

func preflight(ctx context.Context, g Gateway, c Cluster, ops []Operation) []Check {
	checks := []Check{{Name: "集群写入权限", OK: !c.ReadOnly, Message: "目标集群允许通过控制台发布"}}
	if c.ReadOnly {
		checks[0].Message = "集群当前为只读模式"
		return checks
	}
	for _, op := range ops {
		label := op.ResourceType + "/" + op.ResourceID
		current, err := g.Get(ctx, op.ResourceType, op.ResourceID)
		ok := err == nil && hash(current) == op.BaseHash
		message := "编辑基线与网关当前配置一致"
		if err != nil {
			message = err.Error()
		} else if !ok {
			message = "检测到并发修改，请刷新配置后重试"
		}
		checks = append(checks, Check{Name: label + " · 版本检查", OK: ok, Message: message})
		if op.After != nil {
			err = checkResourceIdentity(op.ResourceType, op.ResourceID, op.After)
			if err == nil {
				err = validateTarget(ctx, g, op.ResourceType, op.ResourceID, op.After)
			}
			message = "目标网关 Schema 校验通过"
			if err != nil {
				message = err.Error()
			}
			checks = append(checks, Check{Name: label + " · Schema", OK: err == nil, Message: message})
		}
	}
	if err := checkReferences(ctx, g, ops); err != nil {
		checks = append(checks, Check{Name: "资源引用", OK: false, Message: err.Error()})
	} else {
		checks = append(checks, Check{Name: "资源引用", OK: true, Message: "路由、上游与服务引用检查通过"})
	}
	return checks
}
