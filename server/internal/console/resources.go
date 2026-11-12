package console

import (
	"context"
	"database/sql"
	"net/http"
	"sort"
	"strings"
	"time"
)

func (s *Server) listClusters(w http.ResponseWriter, r *http.Request) {
	items, err := s.Store.Clusters(r.Context())
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, 200, items)
}
func (s *Server) deleteCluster(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), r.PathValue("cluster")
	unlock, err := s.Store.LockCluster(ctx, id)
	if err != nil {
		fail(w, 409, err.Error())
		return
	}
	defer unlock()
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback()
	var publishing bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT FROM changesets WHERE cluster_id=$1 AND status='publishing')`, id).Scan(&publishing); err != nil {
		dbError(w, err)
		return
	}
	if publishing {
		fail(w, 409, "集群正在发布，暂时不能删除连接")
		return
	}
	res, err := tx.ExecContext(ctx, `UPDATE clusters SET removed_at=now(),key_cipher='',read_only=true WHERE id=$1 AND removed_at IS NULL`, id)
	if err != nil {
		dbError(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		dbError(w, sql.ErrNoRows)
		return
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM console_grants WHERE cluster_id=$1`, id); err != nil {
		dbError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		dbError(w, err)
		return
	}
	markAudit(r, id, id, "")
	reply(w, 200, Object{"id": id})
}
func (s *Server) saveCluster(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name        string `json:"name"`
		Environment string `json:"environment"`
		URL         string `json:"url"`
		APIKey      string `json:"api_key"`
		Description string `json:"description"`
		ReadOnly    bool   `json:"read_only"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" || len(in.Name) > 100 {
		fail(w, 400, "请填写 1–100 字的集群名称")
		return
	}
	if in.Environment != "development" && in.Environment != "staging" && in.Environment != "production" {
		fail(w, 400, "请选择有效环境")
		return
	}
	base, err := normalizeURL(in.URL)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	id := r.PathValue("cluster")
	var keyCipher string
	if id != "" {
		unlock, err := s.Store.LockCluster(r.Context(), id)
		if err != nil {
			fail(w, 409, err.Error())
			return
		}
		defer unlock()
		existing, err := s.Store.Cluster(r.Context(), id)
		if err != nil {
			dbError(w, err)
			return
		}
		keyCipher = existing.KeyCipher
		if base != existing.URL || in.Environment != existing.Environment {
			fail(w, 409, "集群接入地址和环境不可更换，请创建新的集群连接，避免历史草稿发布到其他目标")
			return
		}
		var active int
		err = s.Store.DB.QueryRowContext(r.Context(), `SELECT count(*) FROM changesets WHERE cluster_id=$1 AND status='publishing'`, id).Scan(&active)
		if err != nil {
			dbError(w, err)
			return
		}
		if active > 0 {
			fail(w, 409, "集群正在发布，暂时不能修改连接")
			return
		}
	}
	if in.APIKey != "" {
		keyCipher, err = s.Store.Vault.Seal(in.APIKey)
		if err != nil {
			dbError(w, err)
			return
		}
	}
	if keyCipher == "" {
		fail(w, 400, "请填写 Admin API Key")
		return
	}
	if id == "" {
		id = newID()
		_, err = s.Store.DB.ExecContext(r.Context(), `INSERT INTO clusters(id,name,environment,url,description,read_only,key_cipher) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, in.Name, in.Environment, base, in.Description, in.ReadOnly, keyCipher)
	} else {
		_, err = s.Store.DB.ExecContext(r.Context(), `UPDATE clusters SET name=$2,environment=$3,url=$4,description=$5,read_only=$6,key_cipher=$7,status='unchecked',last_checked=NULL,probe_error='',probe_latency_ms=NULL,next_probe_at=now() WHERE id=$1 AND removed_at IS NULL`, id, in.Name, in.Environment, base, in.Description, in.ReadOnly, keyCipher)
	}
	if err != nil {
		dbError(w, err)
		return
	}
	markAudit(r, id, id, "")
	c, err := s.Store.Cluster(r.Context(), id)
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, 200, c)
}
func (s *Server) probeCluster(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var p probeTarget
	err := s.Store.DB.QueryRowContext(ctx, `UPDATE clusters SET next_probe_at=now()+interval '1 minute'
		WHERE id=$1 AND removed_at IS NULL RETURNING id,url,key_cipher,next_probe_at`, r.PathValue("cluster")).Scan(&p.id, &p.url, &p.key, &p.due)
	if err != nil {
		dbError(w, err)
		return
	}
	g, plugins, pluginErr, err := s.checkConnectivity(ctx, p)
	if err != nil {
		dbError(w, err)
		return
	}
	var routes, upstreams int
	routeErr, upstreamErr := pluginErr, pluginErr
	if g != nil {
		diagnostics, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		routes, routeErr = g.collectionCount(diagnostics, "routes")
		upstreams, upstreamErr = g.collectionCount(diagnostics, "upstreams")
	}
	checks := []Check{{Name: "路由读取", OK: routeErr == nil, Message: "可读取路由配置"}, {Name: "上游读取", OK: upstreamErr == nil, Message: "可读取上游配置"}, {Name: "插件发现", OK: pluginErr == nil, Message: "可获取目标集群插件"}}
	for i, e := range []error{routeErr, upstreamErr, pluginErr} {
		if e != nil {
			checks[i].Message = e.Error()
		}
	}
	ok := checksOK(checks)
	auditCheck(r, ok)
	markAudit(r, p.id, p.id, "")
	version := ""
	if g != nil {
		version = g.Version
	}
	reply(w, 200, Object{"ok": ok, "checks": checks, "routes": routes, "upstreams": upstreams, "plugins": plugins, "version": version})
}
func (s *Server) listResources(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	if !readableResourceType(kind) {
		fail(w, 404, "不支持的资源类型")
		return
	}
	_, g, err := s.gateway(r.Context(), r.PathValue("cluster"))
	if err != nil {
		dbError(w, err)
		return
	}
	var items []Resource
	if kind == "credentials" {
		owner := r.URL.Query().Get("owner")
		if !consumerNamePattern.MatchString(owner) {
			fail(w, 400, "请选择消费者")
			return
		}
		items, err = g.listCredentials(r.Context(), owner)
	} else {
		items, err = g.List(r.Context(), kind)
	}
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	sort.Slice(items, func(i, j int) bool {
		if kind == "consumers" {
			return items[i].ID < items[j].ID
		}
		return stringValue(items[i].Value["name"]) < stringValue(items[j].Value["name"])
	})
	for i := range items {
		paths, err := g.ResourceSecretPaths(r.Context(), kind, items[i].ID, items[i].Value)
		if err != nil {
			fail(w, 502, "无法读取插件敏感字段定义，请恢复网关连接后重试")
			return
		}
		items[i].Value = redact(items[i].Value, paths)
	}
	reply(w, 200, Object{"items": items, "total": len(items)})
}
func (s *Server) getResource(w http.ResponseWriter, r *http.Request) {
	kind, id := r.PathValue("kind"), r.PathValue("resource")
	if !readableResourceType(kind) || !resourceIDOK(kind, id) {
		fail(w, 400, "资源类型或标识不正确")
		return
	}
	_, g, err := s.gateway(r.Context(), r.PathValue("cluster"))
	if err != nil {
		dbError(w, err)
		return
	}
	value, err := g.Get(r.Context(), kind, id)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	if value == nil {
		fail(w, 404, "资源不存在")
		return
	}
	paths, err := g.ResourceSecretPaths(r.Context(), kind, id, value)
	if err != nil {
		fail(w, 502, "无法读取插件敏感字段定义，请恢复网关连接后重试")
		return
	}
	reply(w, 200, Resource{ID: id, Value: redact(value, paths), Hash: hash(value)})
}

func readableResourceType(kind string) bool {
	return resourceTypeOK(kind) || kind == "ssls"
}
func (s *Server) listPlugins(w http.ResponseWriter, r *http.Request) {
	_, g, err := s.gateway(r.Context(), r.PathValue("cluster"))
	if err != nil {
		dbError(w, err)
		return
	}
	plugins, err := g.Plugins(r.Context())
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	sort.Strings(plugins)
	reply(w, 200, plugins)
}
func (s *Server) pluginCatalog(w http.ResponseWriter, r *http.Request) {
	_, g, err := s.gateway(r.Context(), r.PathValue("cluster"))
	if err != nil {
		dbError(w, err)
		return
	}
	items, err := g.PluginCatalog(r.Context())
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	reply(w, 200, items)
}
func (s *Server) pluginSchema(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("plugin")
	scope := r.URL.Query().Get("scope")
	if !idPattern.MatchString(name) || (scope != "" && scope != "route" && scope != "consumer") {
		fail(w, 400, "插件名称不正确")
		return
	}
	_, g, err := s.gateway(r.Context(), r.PathValue("cluster"))
	if err != nil {
		dbError(w, err)
		return
	}
	schema, err := g.PluginSchemaFor(r.Context(), name, scope)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	reply(w, 200, schema)
}
