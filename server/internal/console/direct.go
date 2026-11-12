package console

import (
	"fmt"
	"net/http"
	"net/url"
)

// Direct writes and editor-only submissions use the same encrypted operation
// snapshots and publication worker as changes assembled from historical drafts.
func (s *Server) submitConfig(w http.ResponseWriter, r *http.Request, target Cluster, edits []Draft, mode string) {
	ctx := r.Context()
	if mode != "apply" && mode != "submit" {
		fail(w, 404, "接口不存在")
		return
	}
	if mode == "apply" && !needCluster(w, r, s.Store.DB, target.ID, "publish") {
		return
	}
	unlock, err := s.Store.LockCluster(ctx, target.ID)
	if err != nil {
		fail(w, 409, err.Error())
		return
	}
	started := false
	defer func() {
		if !started {
			unlock()
		}
	}()
	cluster, gateway, err := s.gateway(ctx, target.ID)
	if err != nil {
		dbError(w, err)
		return
	}
	if cluster.ReadOnly {
		fail(w, 403, "目标集群为只读模式")
		return
	}
	if cluster.URL != target.URL {
		fail(w, 409, "目标集群已变化，请刷新后重试")
		return
	}
	name, err := url.PathUnescape(r.Header.Get("X-Confirm-Cluster"))
	if mode == "apply" && cluster.Environment == "production" && (err != nil || name != cluster.Name) {
		fail(w, 400, "请输入正确的生产集群名称")
		return
	}
	c := Change{ID: newID(), ClusterID: target.ID, CreatedBy: actor(r), Title: fmt.Sprintf("发布 %d 项配置变更", len(edits)), Reason: "配置管理", Status: "pending"}
	if len(edits) == 1 {
		c.Title = edits[0].Title
		c.Reason = edits[0].ResourceType + "/" + edits[0].ResourceID + " · " + edits[0].Action
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback()
	for _, d := range edits {
		if d.ID != "" {
			// Consume an explicitly opened legacy draft only if it is still
			// the revision the user reviewed, including their final edits.
			blob, err := s.Store.Vault.Seal(DraftPayload{SecretPolicyVersion: 1, Before: d.Before, After: d.After, SensitivePaths: d.SensitivePaths})
			if err != nil {
				dbError(w, err)
				return
			}
			res, err := tx.ExecContext(ctx, `UPDATE drafts SET status='submitted', title=$3, payload_cipher=$4, revision=revision+1, updated_at=now() WHERE id=$1 AND revision=$2 AND status='draft'`, d.ID, d.Revision, d.Title, blob)
			if err != nil {
				dbError(w, err)
				return
			}
			if n, _ := res.RowsAffected(); n != 1 {
				fail(w, 409, "草稿已被修改或提交，请刷新后重试")
				return
			}
		} else {
			var active bool
			err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM drafts WHERE cluster_id=$1 AND resource_type=$2 AND resource_id=$3 AND status='draft')`, target.ID, d.ResourceType, d.ResourceID).Scan(&active)
			if err != nil {
				dbError(w, err)
				return
			}
			if active {
				fail(w, 409, "这个资源已有未提交草稿，请到草稿箱继续编辑")
				return
			}
		}
		c.Operations = append(c.Operations, Operation{DraftID: d.ID, ResourceType: d.ResourceType, ResourceID: d.ResourceID, Action: d.Action, Before: d.Before, After: d.After, SensitivePaths: d.SensitivePaths, BaseHash: d.BaseHash})
	}
	if err = s.insertChange(ctx, tx, c); err != nil {
		dbError(w, err)
		return
	}
	if mode == "apply" {
		c.Status = "publishing"
		if _, err = tx.ExecContext(ctx, "UPDATE changesets SET status='publishing' WHERE id=$1", c.ID); err != nil {
			dbError(w, err)
			return
		}
	}
	if err = tx.Commit(); err != nil {
		dbError(w, err)
		return
	}
	markAudit(r, target.ID, c.ID, mode)
	if mode == "apply" {
		started = true
		s.startPublication(c, cluster, gateway, actor(r), unlock)
	}
	reply(w, 201, Object{"id": c.ID, "cluster_id": c.ClusterID, "status": c.Status})
}
