package console

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

var internalID = regexp.MustCompile(`^[a-f0-9]{32}$`)

type auditContextKey struct{}
type auditEntry struct {
	id                                   int64
	who, action, cluster, target, detail string
	denied, failed                       bool
}

func trace(r *http.Request) *auditEntry {
	a, _ := r.Context().Value(auditContextKey{}).(*auditEntry)
	return a
}
func markAudit(r *http.Request, cluster, target, detail string) {
	if a := trace(r); a != nil {
		a.cluster = cluster
		a.target = target
		a.detail = detail
	}
}

func auditCheck(r *http.Request, ok bool) {
	if a := trace(r); a != nil {
		a.failed = !ok
	}
}

// Only identifiers assigned by the dashboard may be taken from URL parameters into the log.
func requestAudit(r *http.Request, action string) *auditEntry {
	a := &auditEntry{who: "anonymous", action: action}
	for _, key := range []string{"cluster", "draft", "change"} {
		if id := r.PathValue(key); internalID.MatchString(id) {
			a.target = id
			if key == "cluster" {
				a.cluster = id
			}
		}
	}
	if u := r.PathValue("user"); accountName.MatchString(u) {
		a.target = u
	}
	return a
}

type auditWriter struct {
	http.ResponseWriter
	s     *Store
	a     *auditEntry
	wrote bool
}

func (w *auditWriter) WriteHeader(status int) {
	if w.wrote {
		return
	}
	w.wrote = true
	a := w.a
	if a.id != 0 || (status >= 400 && (a.action != "session" || status != 401)) {
		outcome := "success"
		if status == 401 || status == 403 || status == 429 || a.denied {
			outcome = "denied"
		} else if status >= 400 || a.failed {
			outcome = "failed"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var err error
		if a.id == 0 {
			_, err = w.s.DB.ExecContext(ctx, `INSERT INTO audit_events(actor,action,target,cluster_id,detail,outcome,http_status) VALUES($1,$2,$3,$4,$5,$6,$7)`, a.who, a.action, a.target, a.cluster, a.detail, outcome, status)
		} else {
			_, err = w.s.DB.ExecContext(ctx, `UPDATE audit_events SET actor=$2,target=$3,cluster_id=$4,detail=$5,outcome=$6,http_status=$7 WHERE id=$1`, a.id, a.who, a.target, a.cluster, a.detail, outcome, status)
		}
		if err != nil {
			slog.Error("audit finalization failed", "event", a.id, "action", a.action)
		}
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *auditWriter) Write(b []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(b)
}
func (s *Server) audited(action string, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a := requestAudit(r, action)
		r = r.WithContext(context.WithValue(r.Context(), auditContextKey{}, a))
		aw := &auditWriter{ResponseWriter: w, s: s.Store, a: a}
		defer func() {
			if v := recover(); v != nil {
				slog.Error("API request panic", "action", action)
				if !aw.wrote {
					fail(aw, 500, "服务暂时不可用，请稍后重试")
				}
			}
		}()
		h.ServeHTTP(aw, r)
	})
}

// Persist the actual actor and target before the first side effect. A process interruption leaves a started event.
func (s *Server) startAudit(w http.ResponseWriter, r *http.Request) bool {
	a := trace(r)
	if a == nil {
		return true
	}
	if a.id != 0 {
		return true
	}
	err := s.Store.DB.QueryRowContext(r.Context(), `INSERT INTO audit_events(actor,action,target,cluster_id,outcome) VALUES($1,$2,$3,$4,'started') RETURNING id`, a.who, a.action, a.target, a.cluster).Scan(&a.id)
	if err != nil {
		fail(w, 503, "审计记录不可用，操作未执行")
		return false
	}
	return true
}
func denied(w http.ResponseWriter, r *http.Request, status int) {
	if a := trace(r); a != nil {
		a.denied = true
	}
	if status == 404 {
		dbError(w, sql.ErrNoRows)
	} else {
		fail(w, 403, "没有此操作的权限")
	}
}

type queryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func needCluster(w http.ResponseWriter, r *http.Request, q queryRower, id, perm string) bool {
	p := identity(r.Context())
	if a := trace(r); a != nil && internalID.MatchString(id) {
		a.cluster = id
	}
	if !p.permits(id, "view") {
		denied(w, r, 404)
		return false
	}
	if !p.permits(id, perm) {
		denied(w, r, 403)
		return false
	}
	if perm == "edit" || perm == "publish" || perm == "rollback" {
		var ro bool
		err := q.QueryRowContext(r.Context(), "SELECT read_only FROM clusters WHERE id=$1", id).Scan(&ro)
		if err != nil {
			dbError(w, err)
			return false
		}
		if ro {
			fail(w, 403, "目标集群为只读模式")
			return false
		}
	}
	return true
}
func needDraft(w http.ResponseWriter, r *http.Request, q queryRower, id, perm string) bool {
	var cluster string
	err := q.QueryRowContext(r.Context(), "SELECT cluster_id FROM drafts WHERE id=$1", id).Scan(&cluster)
	if err != nil {
		dbError(w, err)
		return false
	}
	return needCluster(w, r, q, cluster, perm)
}
func (s *Server) authorize(perm string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := identity(r.Context())
		switch perm {
		case "session", "body": // The two body-scoped handlers authorize parsed IDs before any access.
		case "admin":
			if p.Role != "administrator" {
				denied(w, r, 403)
				return
			}
		case "list", "auditlist":
			cap := "view"
			if perm == "auditlist" {
				cap = "audit"
				if p.Role != "administrator" && len(p.scope(cap)) == 0 {
					denied(w, r, 403)
					return
				}
			}
			if c := r.URL.Query().Get("cluster_id"); c != "" && !needCluster(w, r, s.Store.DB, c, cap) {
				return
			}
		case "view", "edit", "publish", "rollback":
			if id := r.PathValue("cluster"); id != "" {
				if !needCluster(w, r, s.Store.DB, id, perm) {
					return
				}
			} else if id := r.PathValue("draft"); id != "" {
				if !needDraft(w, r, s.Store.DB, id, perm) {
					return
				}
			} else if id := r.PathValue("change"); id != "" {
				var c, back string
				err := s.Store.DB.QueryRowContext(r.Context(), "SELECT cluster_id,rollback_of FROM changesets WHERE id=$1", id).Scan(&c, &back)
				if err != nil {
					dbError(w, err)
					return
				}
				effective := perm
				if perm == "publish" && back != "" {
					effective = "rollback"
				}
				if !needCluster(w, r, s.Store.DB, c, effective) {
					return
				}
			} else {
				denied(w, r, 403)
				return
			}
		default:
			denied(w, r, 403)
			return
		}
		// Body-scoped actions reserve the event after the target is resolved.
		if perm != "body" && r.Method != "GET" && r.Method != "HEAD" && !s.startAudit(w, r) {
			return
		}
		next(w, r)
	}
}
func (s *Server) listAudit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 200
	var before int64
	var err error
	if n := q.Get("limit"); n != "" {
		limit, err = strconv.Atoi(n)
		if err != nil || limit < 1 || limit > 200 {
			fail(w, 400, "审计分页参数无效")
			return
		}
	}
	if n := q.Get("before_id"); n != "" {
		before, err = strconv.ParseInt(n, 10, 64)
		if err != nil || before < 1 {
			fail(w, 400, "审计分页参数无效")
			return
		}
	}
	rows, err := s.Store.DB.QueryContext(r.Context(), `SELECT id,actor,action,target,CASE WHEN outcome='legacy' THEN '' ELSE detail END,cluster_id,outcome,http_status,created_at FROM audit_events
 WHERE ($1::text[] IS NULL OR cluster_id=ANY($1)) AND ($2='' OR cluster_id=$2) AND ($3='' OR actor=$3) AND ($4='' OR action=$4) AND ($5='' OR outcome=$5) AND ($6::bigint=0 OR id<$6) ORDER BY id DESC LIMIT $7`, identity(r.Context()).scope("audit"), q.Get("cluster_id"), q.Get("actor"), q.Get("action"), q.Get("outcome"), before, limit)
	if err != nil {
		dbError(w, err)
		return
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var id int64
		var who, action, target, detail, cluster, outcome string
		var status int
		var t time.Time
		if err = rows.Scan(&id, &who, &action, &target, &detail, &cluster, &outcome, &status, &t); err != nil {
			dbError(w, err)
			return
		}
		out = append(out, Object{"id": id, "actor": who, "action": action, "target": target, "detail": detail, "cluster_id": cluster, "outcome": outcome, "http_status": status, "created_at": t})
	}
	if err = rows.Err(); err != nil {
		dbError(w, err)
		return
	}
	reply(w, 200, out)
}
func (s *Store) finishChange(c Change, who, status string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := func() error {
		tx, e := s.DB.BeginTx(ctx, nil)
		if e != nil {
			return e
		}
		defer tx.Rollback()
		if _, e = tx.ExecContext(ctx, "UPDATE changesets SET status=$2,updated_at=now() WHERE id=$1", c.ID, status); e != nil {
			return e
		}
		outcome := "failed"
		if status == "succeeded" {
			outcome = "success"
			if _, e = tx.ExecContext(ctx, "UPDATE drafts SET status='published',updated_at=now() WHERE id IN (SELECT draft_id FROM operations WHERE change_id=$1)", c.ID); e != nil {
				return e
			}
		}
		if _, e = tx.ExecContext(ctx, "INSERT INTO audit_events(actor,action,target,cluster_id,outcome) VALUES($1,$2,$3,$4,$5)", who, "change."+status, c.ID, c.ClusterID, outcome); e != nil {
			return e
		}
		return tx.Commit()
	}()
	if err != nil {
		slog.Error("release finalization failed; reconciliation required", "id", c.ID, "error", safeDBError(err))
	}
}
