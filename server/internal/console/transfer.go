package console

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

const bundleFormat = "apisix-dashboard/v1"

type bundleItem struct {
	resourceRef
	Value Object `json:"value"`
}
type resourceBundle struct {
	Format string       `json:"format"`
	Items  []bundleItem `json:"items"`
}

func portable(kind string) bool {
	switch kind {
	case "routes", "upstreams", "services", "plugin_configs", "protos", "stream_routes":
		return true
	}
	return false
}

func (s *Server) exportResources(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Roots []resourceRef `json:"roots"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.Roots) == 0 || len(in.Roots) > 50 {
		fail(w, 400, "请选择 1–50 项资源")
		return
	}
	_, g, err := s.gateway(r.Context(), r.PathValue("cluster"))
	if err != nil {
		dbError(w, err)
		return
	}
	bundle := resourceBundle{Format: bundleFormat}
	seen := map[resourceRef]bool{}
	var collect func(resourceRef) error
	collect = func(ref resourceRef) error {
		if seen[ref] {
			return nil
		}
		if !portable(ref.Kind) || !resourceIDOK(ref.Kind, ref.ID) {
			return fmt.Errorf("资源不可导出")
		}
		if len(seen) >= 50 {
			return fmt.Errorf("依赖展开后超过 50 项")
		}
		seen[ref] = true
		v, err := g.Get(r.Context(), ref.Kind, ref.ID)
		if err != nil {
			return err
		}
		if v == nil {
			return fmt.Errorf("资源不存在：%s", ref)
		}
		for _, dep := range directRefs(ref.Kind, ref.ID, v) {
			if portable(dep.Kind) {
				if err := collect(dep); err != nil {
					return err
				}
			}
		}
		paths, err := g.ResourceSecretPaths(r.Context(), ref.Kind, ref.ID, v)
		if err != nil {
			return err
		}
		bundle.Items = append(bundle.Items, bundleItem{ref, redact(clean(v), paths)})
		return nil
	}
	for _, root := range in.Roots {
		if err := collect(root); err != nil {
			fail(w, 422, err.Error())
			return
		}
	}
	reply(w, 200, bundle)
}

type transferOptions struct {
	Bundle     resourceBundle    `json:"bundle"`
	IDs        map[string]string `json:"ids"`
	Hosts      map[string]string `json:"hosts"`
	Nodes      map[string]string `json:"nodes"`
	Strategies map[string]string `json:"strategies"`
	Token      string            `json:"token"`
}

func rewriteNetwork(v Object, kind string, hosts, nodes map[string]string) error {
	if x, ok := hosts[stringValue(v["host"])]; ok && v["host"] != nil {
		v["host"] = x
	}
	if arr, ok := v["hosts"].([]any); ok {
		for i, h := range arr {
			if x, ok := hosts[stringValue(h)]; ok {
				arr[i] = x
			}
		}
	}
	u := map[string]any(v)
	if kind != "upstreams" {
		u, _ = v["upstream"].(map[string]any)
	}
	switch ns := u["nodes"].(type) {
	case map[string]any:
		out := map[string]any{}
		for old, weight := range ns {
			dst := old
			if n, ok := nodes[old]; ok {
				dst = n
			}
			if _, ok := out[dst]; ok {
				return fmt.Errorf("节点映射产生重复地址")
			}
			out[dst] = weight
		}
		u["nodes"] = out
	case []any:
		for _, node := range ns {
			n, _ := node.(map[string]any)
			host := stringValue(n["host"])
			addr := host
			if n["port"] != nil {
				addr = net.JoinHostPort(host, stringValue(n["port"]))
			}
			if dst, ok := nodes[addr]; ok {
				host, port, err := net.SplitHostPort(dst)
				if err != nil {
					return fmt.Errorf("节点地址须包含主机和端口")
				}
				p, err := strconv.Atoi(port)
				if err != nil || p < 1 || p > 65535 {
					return fmt.Errorf("节点端口无效")
				}
				n["host"] = host
				n["port"] = p
			}
		}
	}
	return nil
}

// Imported protected fields may keep a target value or use a target-side Secret reference.
func portableSecrets(v, masked any) bool {
	if text, ok := masked.(string); ok && text == KeepSecret {
		s, ok := v.(string)
		return ok && (s == KeepSecret || strings.HasPrefix(s, "$secret://") || strings.HasPrefix(s, "$env://"))
	}
	switch m := masked.(type) {
	case Object:
		return portableSecrets(v, map[string]any(m))
	case map[string]any:
		data, _ := v.(map[string]any)
		if obj, ok := v.(Object); ok {
			data = obj
		}
		for k, child := range m {
			if !portableSecrets(data[k], child) {
				return false
			}
		}
	case []any:
		data, _ := v.([]any)
		for i, child := range m {
			if i >= len(data) || !portableSecrets(data[i], child) {
				return false
			}
		}
	}
	return true
}

type transferRow struct {
	resourceRef
	Action       string        `json:"action"`
	Namesakes    []string      `json:"namesakes,omitempty"`
	Diff         []Difference  `json:"diff"`
	Dependencies []resourceRef `json:"dependencies"`
}

func (s *Server) transfer(w http.ResponseWriter, r *http.Request) {
	var in transferOptions
	if !readJSON(w, r, &in) {
		return
	}
	if in.Bundle.Format != bundleFormat || len(in.Bundle.Items) == 0 || len(in.Bundle.Items) > 50 {
		fail(w, 400, "配置包格式或资源数量不正确")
		return
	}
	ctx := r.Context()
	c, g, err := s.gateway(ctx, r.PathValue("cluster"))
	if err != nil {
		dbError(w, err)
		return
	}
	staging := r.PathValue("step") == "stage"
	if !staging && r.PathValue("step") != "preview" {
		fail(w, 404, "接口不存在")
		return
	}
	if staging && (!needCluster(w, r, s.Store.DB, c.ID, "edit") || !s.startAudit(w, r)) {
		return
	}
	if staging && c.ReadOnly {
		fail(w, 403, "该集群为只读接入")
		return
	}
	ops := []Operation{}
	drafts := []Draft{}
	rows := []transferRow{}
	fingerprints := []string{}
	targets := map[resourceRef]bool{}
	namesByKind := map[string]map[string][]string{}
	sources := map[resourceRef]bool{}
	for _, item := range in.Bundle.Items {
		src := item.resourceRef
		dst := src
		if mapped, ok := in.IDs[src.String()]; ok {
			dst.ID = mapped
		}
		if !portable(src.Kind) || !resourceIDOK(src.Kind, src.ID) || !resourceIDOK(dst.Kind, dst.ID) || targets[dst] || sources[src] || len(item.Value) == 0 {
			fail(w, 400, "资源类型、内容或目标 ID 无效或重复")
			return
		}
		targets[dst] = true
		sources[src] = true
		before, err := g.Get(ctx, dst.Kind, dst.ID)
		if err != nil {
			fail(w, 422, err.Error())
			return
		}
		v := clean(item.Value)
		visitReferences(src.Kind, src.ID, v, func(ref resourceRef) string {
			if x, ok := in.IDs[ref.String()]; ok {
				return x
			}
			return ref.ID
		})
		if err = rewriteNetwork(v, src.Kind, in.Hosts, in.Nodes); err != nil {
			fail(w, 400, err.Error())
			return
		}
		row := transferRow{resourceRef: dst, Dependencies: directRefs(dst.Kind, dst.ID, v), Diff: []Difference{}}
		mode := in.Strategies[src.String()]
		if mode != "" && mode != "reuse" && mode != "overwrite" && mode != "create" {
			fail(w, 400, "未知的同名处理方式")
			return
		}
		if name, ok := v["name"].(string); ok && name != "" && before == nil {
			if _, loaded := namesByKind[dst.Kind]; !loaded {
				items, err := g.List(ctx, dst.Kind)
				if err != nil {
					fail(w, 422, err.Error())
					return
				}
				index := map[string][]string{}
				for _, entry := range items {
					n, _ := entry.Value["name"].(string)
					index[n] = append(index[n], entry.ID)
				}
				namesByKind[dst.Kind] = index
			}
			row.Namesakes = namesByKind[dst.Kind][name]
			sort.Strings(row.Namesakes)
		}
		if mode == "reuse" {
			if before == nil {
				fail(w, 422, "无法复用缺失的目标资源 "+dst.String())
				return
			}
			row.Action = "reuse"
		} else {
			paths, err := g.ResourceSecretPaths(ctx, dst.Kind, dst.ID, before, v)
			if err != nil {
				fail(w, 422, err.Error())
				return
			}
			if !portableSecrets(v, redact(v, paths)) {
				fail(w, 422, "敏感字段请使用目标环境的 Secret 引用或保留占位符")
				return
			}
			resolved, err := restoreSecrets(v, before)
			if err != nil {
				fail(w, 422, dst.String()+" · "+err.Error())
				return
			}
			v = Object(resolved.(map[string]any))
			row.Diff = differences(before, v, paths)
			switch {
			case before == nil && len(row.Namesakes) > 0 && mode != "create":
				row.Action = "conflict"
			case before == nil:
				row.Action = "create"
			case len(row.Diff) == 0:
				row.Action = "same"
			case mode == "overwrite":
				row.Action = "update"
			default:
				row.Action = "conflict"
			}
			if row.Action == "create" || row.Action == "update" {
				if err := validateTarget(ctx, g, dst.Kind, dst.ID, v); err != nil {
					fail(w, 422, dst.String()+" · "+err.Error())
					return
				}
				drafts = append(drafts, Draft{ID: newID(), ClusterID: c.ID, ResourceType: dst.Kind, ResourceID: dst.ID, Title: dst.ID, CreatedBy: actor(r), Action: row.Action, Before: before, After: v, BaseHash: hash(before), SensitivePaths: paths})
				ops = append(ops, Operation{ResourceType: dst.Kind, ResourceID: dst.ID, After: v, Action: row.Action})
			}
		}
		fingerprints = append(fingerprints, hash(before), strings.Join(row.Namesakes, ","))
		rows = append(rows, row)
	}
	ready := true
	for _, row := range rows {
		if row.Action == "conflict" {
			ready = false
		}
	}
	if ready {
		if err := checkReferences(ctx, g, ops); err != nil {
			fail(w, 422, err.Error())
			return
		}
	}
	inToken := in.Token
	in.Token = ""
	token := hash(Object{"options": in, "cluster": c.ID, "baselines": fingerprints})
	if !staging {
		reply(w, 200, Object{"rows": rows, "ready": ready && len(drafts) > 0, "token": token})
		return
	}
	if !ready || len(drafts) == 0 || token != inToken {
		fail(w, 409, "请重新预览并处理目标差异")
		return
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback()
	ids := []string{}
	for _, d := range drafts {
		if err = s.Store.insertDraft(ctx, tx, d); err != nil {
			var pg *pgconn.PgError
			if errors.As(err, &pg) && pg.Code == "23505" {
				fail(w, 409, "目标资源已有草稿，本批次未保存")
				return
			}
			dbError(w, err)
			return
		}
		ids = append(ids, d.ID)
	}
	if err = tx.Commit(); err != nil {
		dbError(w, err)
		return
	}
	markAudit(r, c.ID, "", strconv.Itoa(len(ids)))
	reply(w, 201, Object{"draft_ids": ids})
}
