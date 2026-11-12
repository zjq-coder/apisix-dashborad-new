package console

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type grants map[string][]string
type principal struct {
	Username string `json:"username"`
	Role     string `json:"role"`
	Grants   grants `json:"grants"`
}
type principalKey struct{}

func identity(ctx context.Context) principal { p, _ := ctx.Value(principalKey{}).(principal); return p }
func (p principal) permits(cluster, perm string) bool {
	if p.Role == "administrator" {
		return true
	}
	v, found := p.Grants[cluster]
	if !found {
		return false
	}
	if perm == "view" {
		return true
	}
	for _, x := range v {
		if x == perm {
			return true
		}
	}
	return false
}
func (p principal) scope(perm string) []string {
	if p.Role == "administrator" {
		return nil
	}
	ids := []string{}
	for id := range p.Grants {
		if p.permits(id, perm) {
			ids = append(ids, id)
		}
	}
	return ids
}

const grantJSON = `COALESCE((SELECT jsonb_object_agg(g.cluster_id,g.permissions) FROM console_grants g WHERE g.username=a.username),'{}'::jsonb)`

var accountName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$`)

func (s *Store) initAdministrator(ctx context.Context, username, password string, fresh []byte) error {
	if username == "" {
		return errors.New("DASHBOARD_USERNAME is required")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(7419137)"); err != nil {
		return err
	}
	var prev, stored string
	err = tx.QueryRowContext(ctx, "SELECT username,password_hash FROM console_accounts WHERE bootstrap FOR UPDATE").Scan(&prev, &stored)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = tx.ExecContext(ctx, "INSERT INTO console_accounts(username,password_hash,role,bootstrap) VALUES($1,$2,'administrator',true)", username, string(fresh))
	} else if err == nil && (prev != username || bcrypt.CompareHashAndPassword([]byte(stored), []byte(password)) != nil) {
		if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE username IN ($1,$2)", prev, username); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE console_accounts SET username=$1,password_hash=$2,revision=revision+1 WHERE bootstrap", username, string(fresh))
	}
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM console_accounts a WHERE a.username=s.username)"); err != nil {
		return err
	}
	return tx.Commit()
}

type account struct {
	principal
	Enabled   bool      `json:"enabled"`
	Bootstrap bool      `json:"bootstrap"`
	Revision  int       `json:"revision"`
	Created   time.Time `json:"created_at"`
}

const accountSelect = `SELECT a.username,a.role,a.enabled,a.bootstrap,a.revision,a.created_at,` + grantJSON + ` FROM console_accounts a`

func scanAccount(row scanner) (account, error) {
	var a account
	var raw []byte
	err := row.Scan(&a.Username, &a.Role, &a.Enabled, &a.Bootstrap, &a.Revision, &a.Created, &raw)
	if err == nil {
		err = json.Unmarshal(raw, &a.Grants)
	}
	return a, err
}
func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Store.DB.QueryContext(r.Context(), accountSelect+" ORDER BY a.bootstrap DESC,a.username")
	if err != nil {
		dbError(w, err)
		return
	}
	defer rows.Close()
	items := []account{}
	for rows.Next() {
		a, e := scanAccount(rows)
		if e != nil {
			dbError(w, e)
			return
		}
		items = append(items, a)
	}
	if err = rows.Err(); err != nil {
		dbError(w, err)
		return
	}
	reply(w, 200, items)
}
func (s *Server) saveAccount(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username string `json:"username"`
		Role     string `json:"role"`
		Enabled  *bool  `json:"enabled"`
		Password string `json:"password"`
		Grants   grants `json:"grants"`
		Revision int    `json:"revision"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	create := r.Method == "POST"
	name := r.PathValue("user")
	if create {
		name = in.Username
	}
	if !accountName.MatchString(name) || (in.Username != "" && in.Username != name) || (in.Role != "administrator" && in.Role != "member") || in.Enabled == nil || (in.Role == "administrator" && len(in.Grants) > 0) {
		fail(w, 400, "账号、角色或集群授权无效")
		return
	}
	if create || in.Password != "" {
		if len(in.Password) < 12 || len(in.Password) > 72 {
			fail(w, 400, "密码长度必须为 12–72 字节")
			return
		}
	}
	if name == actor(r) || name == s.config.Username {
		fail(w, 403, "不能通过此页面更改当前账号或部署管理员")
		return
	}
	for id, perms := range in.Grants {
		if !internalID.MatchString(id) || len(perms) > 4 {
			fail(w, 400, "集群授权无效")
			return
		}
		seen := map[string]bool{}
		for _, p := range perms {
			if seen[p] || (p != "edit" && p != "publish" && p != "rollback" && p != "audit") {
				fail(w, 400, "集群授权无效")
				return
			}
			seen[p] = true
		}
		if perms == nil {
			in.Grants[id] = []string{}
		}
		sort.Strings(perms)
	}
	var pw []byte
	var err error
	if in.Password != "" {
		pw, err = bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
		if err != nil {
			dbError(w, err)
			return
		}
	}
	ctx := r.Context()
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback()
	var old account
	if create {
		var inserted string
		err = tx.QueryRowContext(ctx, "INSERT INTO console_accounts(username,password_hash,role,enabled) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING username", name, string(pw), in.Role, *in.Enabled).Scan(&inserted)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 409, "账号已存在")
			return
		}
	} else {
		old, err = scanAccount(tx.QueryRowContext(ctx, accountSelect+" WHERE a.username=$1 FOR UPDATE OF a", name))
		if err != nil {
			dbError(w, err)
			return
		}
		if old.Bootstrap {
			fail(w, 403, "部署管理员受保护")
			return
		}
		if old.Revision != in.Revision {
			fail(w, 409, "授权已发生变化，请刷新后重试")
			return
		}
		_, err = tx.ExecContext(ctx, "UPDATE console_accounts SET role=$2,enabled=$3,password_hash=COALESCE(NULLIF($4,''),password_hash),revision=revision+1 WHERE username=$1", name, in.Role, *in.Enabled, string(pw))
	}
	if err != nil {
		dbError(w, err)
		return
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM console_grants WHERE username=$1", name); err != nil {
		dbError(w, err)
		return
	}
	for id, perms := range in.Grants {
		result, e := tx.ExecContext(ctx, "INSERT INTO console_grants(username,cluster_id,permissions) SELECT $1,id,$3::text[] FROM clusters WHERE id=$2 AND removed_at IS NULL FOR SHARE", name, id, perms)
		if e != nil {
			dbError(w, e)
			return
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			fail(w, 400, "集群授权无效")
			return
		}
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE username=$1", name); err != nil {
		dbError(w, err)
		return
	}
	a, err := scanAccount(tx.QueryRowContext(ctx, accountSelect+" WHERE a.username=$1", name))
	if err != nil {
		dbError(w, err)
		return
	}
	// Only allowlisted control-plane metadata enters the audit trail. Never serialize the input.
	detail, _ := json.Marshal(Object{"before_role": old.Role, "role": a.Role, "enabled": a.Enabled, "prior_grants": old.Grants, "grants": a.Grants, "password_changed": len(pw) > 0})
	markAudit(r, "", name, string(detail))
	status := 200
	if create {
		status = 201
	}
	if !commitAccountAudit(w, r, tx, status) {
		return
	}
	reply(w, status, a)
}
func (s *Server) deleteAccount(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("user")
	if name == s.config.Username || name == actor(r) {
		fail(w, 403, "不能通过此页面更改当前账号或部署管理员")
		return
	}
	var in struct {
		Revision int `json:"revision"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	tx, err := s.Store.DB.BeginTx(r.Context(), nil)
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback()
	var version int
	var bootstrap bool
	err = tx.QueryRowContext(r.Context(), "SELECT revision,bootstrap FROM console_accounts WHERE username=$1 FOR UPDATE", name).Scan(&version, &bootstrap)
	if err != nil {
		dbError(w, err)
		return
	}
	if bootstrap {
		fail(w, 403, "部署管理员受保护")
		return
	}
	if version != in.Revision {
		fail(w, 409, "授权已发生变化，请刷新后重试")
		return
	}
	if _, err = tx.ExecContext(r.Context(), "DELETE FROM sessions WHERE username=$1", name); err != nil {
		dbError(w, err)
		return
	}
	if _, err = tx.ExecContext(r.Context(), "DELETE FROM console_accounts WHERE username=$1", name); err != nil {
		dbError(w, err)
		return
	}
	if !commitAccountAudit(w, r, tx, 200) {
		return
	}
	reply(w, 200, Object{"ok": true})
}

// The grant change and its safe before/after audit metadata must commit together.
func commitAccountAudit(w http.ResponseWriter, r *http.Request, tx *sql.Tx, status int) bool {
	a := trace(r)
	if a == nil || a.id == 0 {
		fail(w, 503, "审计记录不可用，操作未执行")
		return false
	}
	result, err := tx.ExecContext(r.Context(), "UPDATE audit_events SET target=$2,detail=$3,outcome='success',http_status=$4 WHERE id=$1", a.id, a.target, a.detail, status)
	if err != nil {
		dbError(w, err)
		return false
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		fail(w, 503, "审计记录不可用，操作未执行")
		return false
	}
	if err = tx.Commit(); err != nil {
		dbError(w, err)
		return false
	}
	return true
}
