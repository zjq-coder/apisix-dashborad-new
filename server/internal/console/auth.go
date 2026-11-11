package console

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"golang.org/x/crypto/bcrypt"
	"net"
	"net/http"
	"time"
)

const cookieName = "apisix_console_session"

func tokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}
func (s *Server) csrf(token string) string {
	mac := hmac.New(sha256.New, []byte(s.config.EncryptionKey))
	mac.Write([]byte("csrf:" + token))
	return hex.EncodeToString(mac.Sum(nil))
}
func (s *Server) reserveLogin(address string) (time.Time, bool) {
	s.loginMu.Lock()
	defer s.loginMu.Unlock()
	now := time.Now()
	valid := []time.Time{}
	for _, t := range s.loginAttempts[address] {
		if now.Sub(t) < time.Minute {
			valid = append(valid, t)
		}
	}
	if len(valid) >= 8 {
		return time.Time{}, false
	}
	s.loginAttempts[address] = append(valid, now)
	if len(s.loginAttempts) > 1000 {
		for ip, times := range s.loginAttempts {
			if len(times) == 0 || now.Sub(times[len(times)-1]) > time.Minute {
				delete(s.loginAttempts, ip)
			}
		}
	}
	return now, true
}

// Successful sign-ins should not lock out coworkers behind the same proxy. Keep failures and in-flight attempts.
func (s *Server) releaseLogin(address string, reservation time.Time) {
	s.loginMu.Lock()
	defer s.loginMu.Unlock()
	q := s.loginAttempts[address]
	for i, t := range q {
		if t.Equal(reservation) {
			q = append(q[:i], q[i+1:]...)
			break
		}
	}
	if len(q) == 0 {
		delete(s.loginAttempts, address)
	} else {
		s.loginAttempts[address] = q
	}
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !originOK(r) {
		fail(w, 403, "请求来源不受信任")
		return
	}
	address, _, _ := net.SplitHostPort(r.RemoteAddr)
	reservation, allowed := s.reserveLogin(address)
	if !allowed {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "尝试次数过多，请稍后再试")
		return
	}
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	ctx := r.Context()
	var hash string
	var enabled bool
	var revision int
	err := s.Store.DB.QueryRowContext(ctx, "SELECT password_hash,enabled,revision FROM console_accounts WHERE username=$1", in.Username).Scan(&hash, &enabled, &revision)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		dbError(w, err)
		return
	}
	known := err == nil
	if known {
		trace(r).who = in.Username
	} else {
		hash = string(s.passwordHash)
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil || !known || !enabled || len(in.Password) > 72 {
		fail(w, 401, "用户名或密码不正确")
		return
	}
	trace(r).target = "session"
	if !s.startAudit(w, r) {
		return
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback()
	var p principal
	var raw []byte
	err = tx.QueryRowContext(ctx, "SELECT a.username,a.role,"+grantJSON+" FROM console_accounts a WHERE a.username=$1 AND a.enabled AND a.revision=$2 FOR SHARE OF a", in.Username, revision).Scan(&p.Username, &p.Role, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 401, "用户名或密码不正确")
		return
	}
	if err == nil {
		err = json.Unmarshal(raw, &p.Grants)
	}
	if err != nil {
		dbError(w, err)
		return
	}
	token := newID() + newID()
	expires := time.Now().Add(12 * time.Hour)
	if _, err = tx.ExecContext(ctx, "INSERT INTO sessions(token_hash,username,expires_at) VALUES($1,$2,$3)", tokenHash(token), p.Username, expires); err != nil {
		dbError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		dbError(w, err)
		return
	}
	s.releaseLogin(address, reservation)
	_, _ = s.Store.DB.ExecContext(r.Context(), `DELETE FROM sessions WHERE expires_at < now()`)
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: token, Path: "/", HttpOnly: true, Secure: s.config.SecureCookie, SameSite: http.SameSiteStrictMode, Expires: expires})
	reply(w, 200, Object{"username": p.Username, "role": p.Role, "grants": p.Grants, "csrf_token": s.csrf(token)})
}
func (s *Server) auth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(cookieName)
		if err != nil {
			fail(w, 401, "请先登录控制台")
			return
		}
		var p principal
		var raw []byte
		err = s.Store.DB.QueryRowContext(r.Context(), "SELECT a.username,a.role,"+grantJSON+" FROM sessions x JOIN console_accounts a USING(username) WHERE a.enabled AND x.token_hash=$1 AND x.expires_at>now()", tokenHash(cookie.Value)).Scan(&p.Username, &p.Role, &raw)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 401, "登录已过期，请重新登录")
			return
		}
		if err == nil {
			err = json.Unmarshal(raw, &p.Grants)
		}
		if err != nil {
			dbError(w, err)
			return
		}
		if a := trace(r); a != nil {
			a.who = p.Username
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if !originOK(r) || !hmac.Equal([]byte(r.Header.Get("X-CSRF-Token")), []byte(s.csrf(cookie.Value))) {
				fail(w, 403, "请求校验失败，请刷新后重试")
				return
			}
		}
		next(w, r.WithContext(context.WithValue(context.WithValue(r.Context(), principalKey{}, p), userContextKey{}, p.Username)))
	})
}
func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	cookie, _ := r.Cookie(cookieName)
	p := identity(r.Context())
	reply(w, 200, Object{"username": p.Username, "role": p.Role, "grants": p.Grants, "csrf_token": s.csrf(cookie.Value)})
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	cookie, _ := r.Cookie(cookieName)
	if _, err := s.Store.DB.ExecContext(r.Context(), "DELETE FROM sessions WHERE token_hash=$1", tokenHash(cookie.Value)); err != nil {
		dbError(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.config.SecureCookie, SameSite: http.SameSiteStrictMode})
	reply(w, 200, Object{"ok": true})
}
