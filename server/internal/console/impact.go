package console

import (
	"errors"
	"net/http"
	"sort"
)

func (s *Server) resourceImpact(w http.ResponseWriter, r *http.Request) {
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
	ctx := r.Context()
	v, err := g.Get(ctx, kind, id)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	if v == nil {
		fail(w, 404, "资源不存在")
		return
	}
	users := []resourceRef{}
	kinds := parentKinds[kind]
	if kind == "global_rules" {
		kinds = []string{"routes"}
	}
	if kind == "plugin_metadata" {
		kinds = []string{"global_rules", "routes", "services", "plugin_configs", "consumer_groups", "consumers"}
	}
	for _, k := range kinds {
		items, err := listParents(ctx, g, k)
		if errors.Is(err, errStreamDisabled) {
			continue
		}
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
		for _, item := range items {
			found := kind == "global_rules"
			if kind == "plugin_metadata" {
				plugins, _ := item.Value["plugins"].(map[string]any)
				_, found = plugins[id]
			}
			for _, d := range directRefs(k, item.ID, item.Value) {
				if d == (resourceRef{kind, id}) {
					found = true
				}
			}
			if found {
				users = append(users, resourceRef{k, item.ID})
			}
		}
	}
	sort.Slice(users, func(i, j int) bool { return users[i].String() < users[j].String() })
	reply(w, 200, Object{"references": users, "dependencies": directRefs(kind, id, v)})
}
