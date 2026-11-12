package console

import (
	"encoding/json"
	"net/http"
)

// The landing page needs only management metadata. Select the visible rows
// directly so even large or sensitive configuration snapshots stay in storage.
func (s *Server) workspace(w http.ResponseWriter, r *http.Request) {
	const query = `SELECT
		COALESCE((SELECT json_agg(d ORDER BY d.updated_at DESC, d.id) FROM (
			SELECT id, title, resource_type, resource_id, action, updated_at
			FROM drafts WHERE cluster_id = c.id AND status = 'draft'
			ORDER BY updated_at DESC, id LIMIT 4
		) d), '[]'),
		COALESCE((SELECT json_agg(h ORDER BY h.created_at DESC, h.id) FROM (
			SELECT id, title, status, rollback_of, created_by, created_at
			FROM changesets WHERE cluster_id = c.id
			ORDER BY created_at DESC, id LIMIT 4
		) h), '[]')
		FROM clusters c WHERE c.id = $1 AND c.removed_at IS NULL`
	var drafts, changes json.RawMessage
	err := s.Store.DB.QueryRowContext(r.Context(), query, r.PathValue("cluster")).Scan(&drafts, &changes)
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, http.StatusOK, Object{"drafts": drafts, "changes": changes})
}
