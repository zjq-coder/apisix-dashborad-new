package console

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/crypto/bcrypt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Config struct {
	DatabaseURL, EncryptionKey, Username, Password, StaticDir string
	SecureCookie                                              bool
}
type Server struct {
	Store         *Store
	config        Config
	passwordHash  []byte
	mux           *http.ServeMux
	workers       sync.WaitGroup
	stopProbes    context.CancelFunc
	loginMu       sync.Mutex
	loginAttempts map[string][]time.Time
}
type userContextKey struct{}

func NewServer(ctx context.Context, c Config) (*Server, error) {
	if len(c.Password) < 12 {
		return nil, fmt.Errorf("DASHBOARD_PASSWORD must contain at least 12 characters")
	}
	vault, err := NewVault(c.EncryptionKey)
	if err != nil {
		return nil, err
	}
	store, err := OpenStore(ctx, c.DatabaseURL, vault)
	if err != nil {
		return nil, err
	}
	pw, err := bcrypt.GenerateFromPassword([]byte(c.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	if err = store.initAdministrator(ctx, c.Username, c.Password, pw); err != nil {
		store.DB.Close()
		return nil, err
	}
	c.Password = ""
	s := &Server{Store: store, config: c, passwordHash: pw, mux: http.NewServeMux(), loginAttempts: map[string][]time.Time{}}
	s.routes()
	probeCtx, stop := context.WithCancel(context.Background())
	s.stopProbes = stop
	s.workers.Add(1)
	go func() { defer s.workers.Done(); s.probeLoop(probeCtx) }()
	return s, nil
}
func (s *Server) Close() {
	if s.stopProbes != nil {
		s.stopProbes()
	}
	s.workers.Wait()
	_ = s.Store.DB.Close()
}
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		defer func() {
			if recovered := recover(); recovered != nil {
				slog.Error("request panic", "path", r.URL.Path)
				fail(w, 500, "服务暂时不可用，请稍后重试")
			}
		}()
		s.mux.ServeHTTP(w, r)
	})
}
func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.Store.DB.PingContext(ctx); err != nil {
			fail(w, 503, "数据库不可用")
			return
		}
		reply(w, 200, Object{"status": "ok"})
	})
	s.mux.Handle("POST /api/v1/login", s.audited("login", http.HandlerFunc(s.login)))
	s.handle("GET /api/v1/session", "session", "session", s.session)
	s.handle("POST /api/v1/logout", "session", "logout", s.logout)
	s.handle("GET /api/v1/clusters", "list", "cluster.list", s.listClusters)
	s.handle("GET /api/v1/clusters/{cluster}/workspace", "view", "workspace.read", s.workspace)
	s.handle("POST /api/v1/clusters", "admin", "cluster.save", s.saveCluster)
	s.handle("PUT /api/v1/clusters/{cluster}", "admin", "cluster.save", s.saveCluster)
	s.handle("DELETE /api/v1/clusters/{cluster}", "admin", "cluster.delete", s.deleteCluster)
	s.handle("POST /api/v1/clusters/{cluster}/probe", "admin", "cluster.probe", s.probeCluster)
	s.handle("POST /api/v1/clusters/{cluster}/validate", "view", "resource.validate", s.validateConfig)
	s.handle("GET /api/v1/clusters/{cluster}/resources/{kind}", "view", "resource.list", s.listResources)
	s.handle("GET /api/v1/clusters/{cluster}/resources/{kind}/{resource}", "view", "resource.read", s.getResource)
	s.handle("GET /api/v1/clusters/{cluster}/resources/{kind}/{resource}/impact", "view", "resource.impact", s.resourceImpact)
	s.handle("POST /api/v1/clusters/{cluster}/export", "view", "bundle.export", s.exportResources)
	s.handle("POST /api/v1/clusters/{cluster}/config/{mode}", "edit", "config.save", s.saveDraft)
	s.handle("POST /api/v1/clusters/{cluster}/routes/batch-delete/{mode}", "edit", "config.batch-delete", s.deleteRouteDrafts)
	s.handle("POST /api/v1/clusters/{cluster}/routes/delete-drafts", "edit", "draft.save", s.deleteRouteDrafts)
	s.handle("POST /api/v1/clusters/{cluster}/transfer/{step}", "view", "bundle.transfer", s.transfer)
	s.handle("GET /api/v1/clusters/{cluster}/plugins", "view", "plugin.list", s.listPlugins)
	s.handle("GET /api/v1/clusters/{cluster}/plugins/catalog", "view", "plugin.catalog", s.pluginCatalog)
	s.handle("GET /api/v1/clusters/{cluster}/plugins/{plugin}/schema", "view", "plugin.schema", s.pluginSchema)
	s.handle("POST /api/v1/clusters/{cluster}/plugins/{plugin}/validate", "view", "plugin.validate", s.validatePlugin)
	s.handle("GET /api/v1/drafts", "list", "draft.list", s.listDrafts)
	s.handle("POST /api/v1/drafts", "body", "draft.save", s.saveDraft)
	s.handle("GET /api/v1/drafts/{draft}", "view", "draft.read", s.getDraft)
	s.handle("PUT /api/v1/drafts/{draft}", "edit", "draft.save", s.saveDraft)
	s.handle("DELETE /api/v1/drafts/{draft}", "edit", "draft.discard", s.discardDraft)
	s.handle("POST /api/v1/drafts/{draft}/validate", "view", "draft.validate", s.validateDraft)
	s.handle("GET /api/v1/changesets", "list", "change.list", s.listChanges)
	s.handle("POST /api/v1/changesets", "body", "change.create", s.createChange)
	s.handle("GET /api/v1/changesets/{change}", "view", "change.read", s.getChange)
	s.handle("POST /api/v1/changesets/{change}/validate", "view", "change.validate", s.validateChange)
	s.handle("POST /api/v1/changesets/{change}/publish", "publish", "change.publish", s.publishChange)
	s.handle("POST /api/v1/changesets/{change}/reconcile", "publish", "change.reconcile", s.reconcileChange)
	s.handle("POST /api/v1/changesets/{change}/rollback", "rollback", "change.rollback-preview", s.rollbackChange)
	s.handle("POST /api/v1/changesets/{change}/cancel", "publish", "change.cancel", s.cancelChange)
	s.handle("GET /api/v1/audit", "auditlist", "audit.list", s.listAudit)
	s.handle("GET /api/v1/users", "admin", "account.list", s.listAccounts)
	s.handle("POST /api/v1/users", "admin", "account.create", s.saveAccount)
	s.handle("PUT /api/v1/users/{user}", "admin", "account.update", s.saveAccount)
	s.handle("DELETE /api/v1/users/{user}", "admin", "account.delete", s.deleteAccount)
	s.mux.HandleFunc("/", s.static)
}
func (s *Server) handle(pattern, permission, action string, handler http.HandlerFunc) {
	s.mux.Handle(pattern, s.audited(action, s.auth(s.authorize(permission, handler))))
}
func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, message string) {
	reply(w, status, Object{"error": message})
}
func readJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		fail(w, 400, "请求格式不正确或内容过大")
		return false
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		fail(w, 400, "请求包含多余内容")
		return false
	}
	return true
}
func actor(r *http.Request) string { v, _ := r.Context().Value(userContextKey{}).(string); return v }
func dbError(w http.ResponseWriter, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "记录不存在或已被移除")
		return
	}
	slog.Error("database operation failed", "error", safeDBError(err))
	fail(w, 500, "数据操作失败，请检查服务日志")
}
func safeDBError(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("%T", err)
}
func (s *Server) gateway(ctx context.Context, id string) (Cluster, *HTTPGateway, error) {
	c, err := s.Store.Cluster(ctx, id)
	if err != nil {
		return c, nil, err
	}
	var key string
	if err = s.Store.Vault.Open(c.KeyCipher, &key); err != nil {
		return c, nil, fmt.Errorf("集群凭据解密失败，请检查服务端密钥")
	}
	g, err := NewGateway(c.URL, key)
	return c, g, err
}
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		fail(w, 404, "接口不存在")
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		w.WriteHeader(405)
		return
	}
	base := filepath.Clean(s.config.StaticDir)
	name := filepath.Join(base, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/")))
	relative, err := filepath.Rel(base, name)
	if err != nil || strings.HasPrefix(relative, "..") {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(name)
	if err != nil || info.IsDir() {
		name = filepath.Join(base, "index.html")
	}
	if strings.Contains(r.URL.Path, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeFile(w, r, name)
}
func originOK(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return r.Header.Get("Sec-Fetch-Site") != "cross-site"
	}
	u, err := url.Parse(origin)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && strings.EqualFold(u.Host, r.Host)
}
