package console

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

func (s *Server) listChanges(w http.ResponseWriter, r *http.Request) {
	items, err := s.Store.Changes(r.Context(), r.URL.Query().Get("cluster_id"))
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, 200, items)
}
func (s *Server) getChange(w http.ResponseWriter, r *http.Request) {
	c, err := s.Store.Change(r.Context(), r.PathValue("change"))
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, 200, publicChange(c))
}
func operationRank(op Operation) int {
	rank := 0
	switch op.ResourceType {
	case "consumers", "services", "plugin_configs":
		rank = 2
	case "global_rules", "consumer_groups":
		rank = 1
	case "routes", "stream_routes", "credentials":
		rank = 3
	}
	if op.Action == "delete" {
		return 7 - rank
	}
	return rank
}
func orderOperations(ops []Operation) {
	sort.SliceStable(ops, func(i, j int) bool { return operationRank(ops[i]) < operationRank(ops[j]) })
}
func (s *Server) insertChange(ctx context.Context, tx *sql.Tx, c Change) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO changesets(id,cluster_id,title,reason,rollback_of,created_by) VALUES($1,$2,$3,$4,$5,$6)`, c.ID, c.ClusterID, c.Title, c.Reason, c.RollbackOf, c.CreatedBy)
	if err != nil {
		return err
	}
	orderOperations(c.Operations)
	for i, op := range c.Operations {
		blob, err := s.Store.Vault.Seal(DraftPayload{SecretPolicyVersion: 1, Before: op.Before, After: op.After, SensitivePaths: op.SensitivePaths})
		if err != nil {
			return err
		}
		c.Operations[i].ID = newID()
		_, err = tx.ExecContext(ctx, `INSERT INTO operations(id,change_id,draft_id,position,resource_type,resource_id,action,base_hash,payload_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, c.Operations[i].ID, c.ID, op.DraftID, i, op.ResourceType, op.ResourceID, op.Action, op.BaseHash, blob)
		if err != nil {
			return err
		}
	}
	return nil
}
func (s *Server) createChange(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DraftIDs []string `json:"draft_ids"`
		Title    string   `json:"title"`
		Reason   string   `json:"reason"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.DraftIDs) == 0 || len(in.DraftIDs) > 50 || strings.TrimSpace(in.Reason) == "" || len(in.Reason) > 2000 {
		fail(w, 400, "请选择 1–50 个草稿并填写变更说明（最多 2000 字）")
		return
	}
	if len(in.Title) > 200 {
		fail(w, 400, "标题过长")
		return
	}
	// Lock in a stable order to avoid deadlocks between overlapping submissions.
	sort.Strings(in.DraftIDs)
	for _, id := range in.DraftIDs {
		if !needDraft(w, r, s.Store.DB, id, "edit") {
			return
		}
	}
	if !s.startAudit(w, r) {
		return
	}
	tx, err := s.Store.DB.BeginTx(r.Context(), nil)
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback()
	c := Change{ID: newID(), Title: in.Title, Reason: in.Reason, CreatedBy: actor(r)}
	seen := map[string]bool{}
	for _, id := range in.DraftIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		d, err := s.Store.scanDraft(tx.QueryRowContext(r.Context(), `SELECT `+draftColumns+` FROM drafts WHERE id=$1 FOR UPDATE`, id))
		if err != nil {
			dbError(w, err)
			return
		}
		if d.Status != "draft" {
			fail(w, 409, "部分草稿已提交或丢弃，请刷新列表")
			return
		}
		if c.ClusterID != "" && c.ClusterID != d.ClusterID {
			fail(w, 400, "一个变更只能包含同一集群的资源")
			return
		}
		c.ClusterID = d.ClusterID
		c.Operations = append(c.Operations, Operation{DraftID: d.ID, ResourceType: d.ResourceType, ResourceID: d.ResourceID, Action: d.Action, BaseHash: d.BaseHash, Before: d.Before, After: d.After, SensitivePaths: d.SensitivePaths})
		_, err = tx.ExecContext(r.Context(), `UPDATE drafts SET status='submitted',updated_at=now() WHERE id=$1`, id)
		if err != nil {
			dbError(w, err)
			return
		}
	}
	if c.Title == "" {
		c.Title = fmt.Sprintf("发布 %d 项配置变更", len(c.Operations))
	}
	if err = s.insertChange(r.Context(), tx, c); err != nil {
		dbError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		dbError(w, err)
		return
	}
	markAudit(r, c.ClusterID, c.ID, "")
	c, err = s.Store.Change(r.Context(), c.ID)
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, 201, publicChange(c))
}
func (s *Server) validateChange(w http.ResponseWriter, r *http.Request) {
	c, err := s.Store.Change(r.Context(), r.PathValue("change"))
	if err != nil {
		dbError(w, err)
		return
	}
	if c.Status != "pending" {
		fail(w, 409, "只有待发布变更可以重新校验")
		return
	}
	cluster, g, err := s.gateway(r.Context(), c.ClusterID)
	if err != nil {
		dbError(w, err)
		return
	}
	checks := preflight(r.Context(), g, cluster, c.Operations)
	auditCheck(r, checksOK(checks))
	reply(w, 200, Object{"ok": checksOK(checks), "checks": checks})
}
func (s *Server) publishChange(w http.ResponseWriter, r *http.Request) {
	c, err := s.Store.Change(r.Context(), r.PathValue("change"))
	if err != nil {
		dbError(w, err)
		return
	}
	if c.Status != "pending" {
		reply(w, 200, publicChange(c))
		return
	}
	unlock, err := s.Store.LockCluster(r.Context(), c.ClusterID)
	if err != nil {
		fail(w, 409, err.Error())
		return
	}
	cluster, g, err := s.gateway(r.Context(), c.ClusterID)
	if err != nil {
		unlock()
		dbError(w, err)
		return
	}
	if cluster.ReadOnly {
		unlock()
		fail(w, 403, "目标集群为只读模式")
		return
	}
	result, err := s.Store.DB.ExecContext(r.Context(), `UPDATE changesets SET status='publishing',updated_at=now() WHERE id=$1 AND status='pending'`, c.ID)
	if err != nil {
		unlock()
		dbError(w, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		unlock()
		fail(w, 409, "变更状态已经变化")
		return
	}
	s.startPublication(c, cluster, g, actor(r), unlock)
	reply(w, 202, Object{"id": c.ID, "status": "publishing"})
}

func (s *Server) startPublication(c Change, cluster Cluster, g Gateway, publisher string, unlock func()) {
	s.workers.Add(1)
	go func() {
		defer s.workers.Done()
		defer unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		s.executeChange(ctx, c, cluster, g, publisher)
	}()
}

// A transport failure is not evidence that a write failed: verify the resource before deciding.
func applyOperation(ctx context.Context, g Gateway, op Operation) (string, Object, string) {
	current, err := g.Get(ctx, op.ResourceType, op.ResourceID)
	if err != nil {
		return "failed", nil, err.Error()
	}
	if hash(current) != op.BaseHash {
		return "conflict", nil, "资源在发布过程中被其他写入方修改，已停止后续操作"
	}
	if op.Action == "delete" {
		err = g.Delete(ctx, op.ResourceType, op.ResourceID)
	} else {
		err = g.Put(ctx, op.ResourceType, op.ResourceID, op.After)
	}
	actual, readErr := g.Get(ctx, op.ResourceType, op.ResourceID)
	if readErr != nil {
		return "unknown", nil, "写入后的状态无法读取；请恢复连接后核对结果，勿重复提交"
	}
	if matchesWrite(op.ResourceType, op.After, actual) {
		return "applied", actual, ""
	}
	if err != nil && hash(actual) == op.BaseHash {
		return "failed", actual, err.Error()
	}
	return "unknown", actual, "配置回读与预期不同，可能包含网关归一化或外部修改，请核对实际配置"
}
func (s *Server) executeChange(ctx context.Context, c Change, cluster Cluster, g Gateway, publisher string) {
	checks := preflight(ctx, g, cluster, c.Operations)
	if !checksOK(checks) {
		status := "failed"
		message := "发布前校验失败"
		for _, check := range checks {
			if !check.OK {
				message = check.Message
				if strings.Contains(check.Name, "版本检查") {
					status = "conflict"
				}
				break
			}
		}
		for _, op := range c.Operations {
			_ = s.Store.OperationResult(context.Background(), op.ID, "skipped", message, nil)
		}
		s.Store.finishChange(c, publisher, status)
		return
	}
	for i, op := range c.Operations {
		if err := s.Store.OperationResult(ctx, op.ID, "applying", "", nil); err != nil {
			s.Store.finishChange(c, publisher, "unknown")
			return
		}
		status, actual, message := applyOperation(ctx, g, op)
		if err := s.Store.OperationResult(context.Background(), op.ID, status, message, actual); err != nil {
			s.Store.finishChange(c, publisher, "unknown")
			return
		}
		if status != "applied" {
			for _, remaining := range c.Operations[i+1:] {
				_ = s.Store.OperationResult(context.Background(), remaining.ID, "skipped", "前序操作未完成", nil)
			}
			s.Store.finishChange(c, publisher, status)
			return
		}
	}
	s.Store.finishChange(c, publisher, "succeeded")
}

func (s *Server) reconcileChange(w http.ResponseWriter, r *http.Request) {
	c, err := s.Store.Change(r.Context(), r.PathValue("change"))
	if err != nil {
		dbError(w, err)
		return
	}
	if c.Status != "unknown" && c.Status != "publishing" {
		fail(w, 409, "当前变更不需要恢复核对")
		return
	}
	unlock, err := s.Store.LockCluster(r.Context(), c.ClusterID)
	if err != nil {
		fail(w, 409, "发布仍在运行，请等待完成")
		return
	}
	defer unlock()
	_, g, err := s.gateway(r.Context(), c.ClusterID)
	if err != nil {
		dbError(w, err)
		return
	}
	all := true
	unknown := false
	for _, op := range c.Operations {
		if op.Status == "applied" {
			continue
		}
		if op.Status != "applying" && op.Status != "unknown" {
			all = false
			continue
		}
		actual, err := g.Get(r.Context(), op.ResourceType, op.ResourceID)
		if err != nil {
			unknown = true
			all = false
			continue
		}
		if matchesWrite(op.ResourceType, op.After, actual) {
			if err = s.Store.OperationResult(r.Context(), op.ID, "applied", "经人工触发回读确认", actual); err != nil {
				dbError(w, err)
				return
			}
		} else {
			all = false
			status := "unknown"
			message := "当前值与基线和预期值均不一致，需人工核对"
			if hash(actual) == op.BaseHash {
				status = "failed"
				message = "确认配置未写入"
			} else {
				unknown = true
			}
			if err = s.Store.OperationResult(r.Context(), op.ID, status, message, actual); err != nil {
				dbError(w, err)
				return
			}
		}
	}
	status := "failed"
	if all {
		status = "succeeded"
	} else if unknown {
		status = "unknown"
	}
	if err = s.Store.ChangeStatus(r.Context(), c.ID, status); err != nil {
		dbError(w, err)
		return
	}
	if status == "succeeded" {
		if _, err = s.Store.DB.ExecContext(r.Context(), `UPDATE drafts SET status='published',updated_at=now() WHERE id IN (SELECT draft_id FROM operations WHERE change_id=$1)`, c.ID); err != nil {
			dbError(w, err)
			return
		}
	}
	auditCheck(r, status == "succeeded")
	markAudit(r, c.ClusterID, c.ID, status)
	c, err = s.Store.Change(r.Context(), c.ID)
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, 200, publicChange(c))
}
func (s *Server) rollbackChange(w http.ResponseWriter, r *http.Request) {
	source, err := s.Store.Change(r.Context(), r.PathValue("change"))
	if err != nil {
		dbError(w, err)
		return
	}
	if source.Status == "publishing" || source.Status == "pending" || source.Status == "unknown" {
		fail(w, 409, "请先等待发布完成或核对未知结果")
		return
	}
	var existing string
	err = s.Store.DB.QueryRowContext(r.Context(), `SELECT id FROM changesets WHERE rollback_of=$1`, source.ID).Scan(&existing)
	if err == nil {
		c, err := s.Store.Change(r.Context(), existing)
		if err != nil {
			dbError(w, err)
			return
		}
		reply(w, 200, publicChange(c))
		return
	}
	if err != sql.ErrNoRows {
		dbError(w, err)
		return
	}
	c := Change{ID: newID(), ClusterID: source.ClusterID, Title: "回退 · " + source.Title, Reason: "恢复变更 " + source.ID[:8] + " 执行前的配置", RollbackOf: source.ID, CreatedBy: actor(r)}
	for _, op := range source.Operations {
		if op.Status != "applied" {
			continue
		}
		action := "update"
		if op.Before == nil {
			action = "delete"
		} else if op.ActualAfter == nil {
			action = "create"
		}
		c.Operations = append(c.Operations, Operation{ResourceType: op.ResourceType, ResourceID: op.ResourceID, Action: action, BaseHash: hash(op.ActualAfter), Before: op.ActualAfter, After: op.Before, SensitivePaths: op.SensitivePaths})
	}
	if len(c.Operations) == 0 {
		fail(w, 400, "没有已应用的操作可回退")
		return
	}
	tx, err := s.Store.DB.BeginTx(r.Context(), nil)
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback()
	if err = s.insertChange(r.Context(), tx, c); err != nil {
		dbError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		dbError(w, err)
		return
	}
	markAudit(r, c.ClusterID, c.ID, source.ID)
	c, err = s.Store.Change(r.Context(), c.ID)
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, 201, publicChange(c))
}
func (s *Server) cancelChange(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("change")
	tx, err := s.Store.DB.BeginTx(r.Context(), nil)
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback()
	var status string
	if err = tx.QueryRowContext(r.Context(), `SELECT status FROM changesets WHERE id=$1 FOR UPDATE`, id).Scan(&status); err != nil {
		dbError(w, err)
		return
	}
	if status != "pending" && status != "failed" && status != "conflict" {
		fail(w, 409, "当前变更不能取消；已应用操作请通过回退处理")
		return
	}
	var applied int
	if err = tx.QueryRowContext(r.Context(), `SELECT count(*) FROM operations WHERE change_id=$1 AND status IN ('applied','applying','unknown')`, id).Scan(&applied); err != nil {
		dbError(w, err)
		return
	}
	if applied > 0 {
		fail(w, 409, "变更包含已应用或结果未知的操作，请先回退或核对")
		return
	}
	_, err = tx.ExecContext(r.Context(), `UPDATE changesets SET status='cancelled',updated_at=now() WHERE id=$1`, id)
	if err != nil {
		dbError(w, err)
		return
	}
	_, err = tx.ExecContext(r.Context(), `UPDATE drafts SET status='discarded',updated_at=now() WHERE id IN (SELECT draft_id FROM operations WHERE change_id=$1) AND status='submitted'`, id)
	if err != nil {
		dbError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		dbError(w, err)
		return
	}

	reply(w, 200, Object{"ok": true})
}
