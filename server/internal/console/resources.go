package console

import (
	"net/http"
	"sort"
	"strings"
)

func (s *Server) listClusters(w http.ResponseWriter, r *http.Request) {
	items, err := s.Store.Clusters(r.Context())
	if err != nil {
		dbError(w, err)
		return
	}
	reply(w, 200, items)
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
		_, err = s.Store.DB.ExecContext(r.Context(), `UPDATE clusters SET name=$2,environment=$3,url=$4,description=$5,read_only=$6,key_cipher=$7,status='unchecked',last_checked=NULL WHERE id=$1`, id, in.Name, in.Environment, base, in.Description, in.ReadOnly, keyCipher)
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
	c, g, err := s.gateway(r.Context(), r.PathValue("cluster"))
	if err != nil {
		dbError(w, err)
		return
	}
	routes, routeErr := g.List(r.Context(), "routes")
	upstreams, upstreamErr := g.List(r.Context(), "upstreams")
	plugins, pluginErr := g.Plugins(r.Context())
	checks := []Check{{Name: "路由读取", OK: routeErr == nil, Message: "可读取路由配置"}, {Name: "上游读取", OK: upstreamErr == nil, Message: "可读取上游配置"}, {Name: "插件发现", OK: pluginErr == nil, Message: "可获取目标集群插件"}}
	for i, e := range []error{routeErr, upstreamErr, pluginErr} {
		if e != nil {
			checks[i].Message = e.Error()
		}
	}
	status := "connected"
	if routeErr != nil || upstreamErr != nil || pluginErr != nil {
		status = "error"
	}
	_, err = s.Store.DB.ExecContext(r.Context(), `UPDATE clusters SET status=$2,last_checked=now(),version=$3 WHERE id=$1`, c.ID, status, g.Version)
	if err != nil {
		dbError(w, err)
		return
	}
	auditCheck(r, status == "connected")
	markAudit(r, c.ID, c.ID, status)
	reply(w, 200, Object{"ok": status == "connected", "checks": checks, "routes": len(routes), "upstreams": len(upstreams), "plugins": len(plugins), "version": g.Version})
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
