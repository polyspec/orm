package schema

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// CRUDManifest is the deterministic intermediate input for a profile-specific
// CRUD emitter. It contains resolved metadata only; it contains no SQL or
// database driver instructions.
type CRUDManifest struct {
	SchemaHash  string           `json:"schema_hash"`
	Fields      []CRUDField      `json:"fields"`
	PublicKeys  []CRUDPublicKey  `json:"public_keys"`
	Routes      []CRUDRoute      `json:"routes"`
	Permissions []CRUDPermission `json:"permissions"`
}

type CRUDField struct {
	Entity   string `json:"entity"`
	Field    string `json:"field"`
	Relation string `json:"relation"`
	FK       string `json:"fk"`
	Public   string `json:"public,omitempty"`
	Required bool   `json:"required"`
	Order    int    `json:"order,omitempty"`
}
type CRUDPublicKey struct {
	Entity string `json:"entity"`
	Field  string `json:"field"`
	Type   string `json:"type"`
	Unique bool   `json:"unique"`
	Stable bool   `json:"stable"`
}
type CRUDRoute struct {
	ID         string        `json:"id"`
	Path       string        `json:"path"`
	Scopes     []CRUDBinding `json:"scopes"`
	Filters    []CRUDBinding `json:"filters"`
	Resource   *CRUDBinding  `json:"resource,omitempty"`
	Operations []string      `json:"operations"`
}
type CRUDBinding struct {
	Param string `json:"param"`
	Field string `json:"field"`
	Order int    `json:"order,omitempty"`
}
type CRUDPermission struct {
	Route  string `json:"route"`
	Action string `json:"action"`
	Owner  string `json:"owner"`
}

// BuildCRUDManifest validates and resolves the orm:* extension into a stable
// profile input. Callers can marshal the returned value without map ordering.
func (m *Manifest) BuildCRUDManifest() (*CRUDManifest, error) {
	if err := m.ValidateORM(); err != nil {
		return nil, err
	}
	out := &CRUDManifest{SchemaHash: m.SchemaHash}
	for _, x := range m.ORM {
		switch x.Kind {
		case "field":
			out.Fields = append(out.Fields, CRUDField{Entity: beforeDot(x.Name), Field: afterDot(x.Name), Relation: x.Args["relation"], FK: x.Args["fk"], Public: x.Args["public"], Required: x.Args["required"] == "true", Order: atoi0(x.Args["order"])})
		case "public-key":
			out.PublicKeys = append(out.PublicKeys, CRUDPublicKey{Entity: x.Args["entity"], Field: x.Args["field"], Type: x.Args["type"], Unique: x.Args["unique"] == "true", Stable: x.Args["stable"] == "true"})
		case "scope", "filter":
			r := routeByID(&out.Routes, x.Args["route"])
			b := CRUDBinding{Param: x.Args["param"], Field: x.Args["field"]}
			if x.Kind == "scope" {
				r.Scopes = append(r.Scopes, b)
			} else {
				r.Filters = append(r.Filters, b)
			}
		case "resource-key":
			r := routeByID(&out.Routes, x.Args["route"])
			b := CRUDBinding{Param: x.Args["param"], Field: x.Args["field"]}
			r.Resource = &b
		case "operation":
			r := routeByID(&out.Routes, x.Args["route"])
			r.Operations = append(r.Operations, x.Args["method"])
		case "permission":
			out.Permissions = append(out.Permissions, CRUDPermission{Route: x.Args["route"], Action: x.Args["action"], Owner: x.Args["owner"]})
		}
	}
	orders := map[string]int{}
	for _, f := range out.Fields {
		if f.Relation == "scope" {
			orders[f.Entity+"."+f.Field] = f.Order
		}
	}
	for i := range out.Routes {
		for j := range out.Routes[i].Scopes {
			out.Routes[i].Scopes[j].Order = orders[out.Routes[i].Scopes[j].Field]
		}
	}
	for _, x := range m.ORM {
		if x.Kind == "path" {
			r := routeByID(&out.Routes, x.Args["route"])
			r.Path = x.Name
		}
	}
	for i := range out.Routes {
		sort.Slice(out.Routes[i].Scopes, func(a, b int) bool { return out.Routes[i].Scopes[a].Param < out.Routes[i].Scopes[b].Param })
		sort.Strings(out.Routes[i].Operations)
	}
	sort.Slice(out.Fields, func(i, j int) bool {
		return out.Fields[i].Entity+"."+out.Fields[i].Field < out.Fields[j].Entity+"."+out.Fields[j].Field
	})
	sort.Slice(out.PublicKeys, func(i, j int) bool {
		return out.PublicKeys[i].Entity+"."+out.PublicKeys[i].Field < out.PublicKeys[j].Entity+"."+out.PublicKeys[j].Field
	})
	sort.Slice(out.Routes, func(i, j int) bool { return out.Routes[i].ID < out.Routes[j].ID })
	sort.Slice(out.Permissions, func(i, j int) bool {
		return out.Permissions[i].Route+out.Permissions[i].Action < out.Permissions[j].Route+out.Permissions[j].Action
	})
	for _, r := range out.Routes {
		if len(r.Operations) == 0 {
			return nil, fmt.Errorf("route %s: operation is required", r.ID)
		}
	}
	return out, nil
}

func (m *CRUDManifest) MarshalIndent() ([]byte, error) { return json.MarshalIndent(m, "", "  ") }
func beforeDot(s string) string {
	i := strings.IndexByte(s, '.')
	if i < 0 {
		return s
	}
	return s[:i]
}
func afterDot(s string) string {
	i := strings.IndexByte(s, '.')
	if i < 0 {
		return ""
	}
	return s[i+1:]
}
func atoi0(s string) int { var n int; fmt.Sscanf(s, "%d", &n); return n }
func routeByID(routes *[]CRUDRoute, id string) *CRUDRoute {
	for i := range *routes {
		if (*routes)[i].ID == id {
			return &(*routes)[i]
		}
	}
	*routes = append(*routes, CRUDRoute{ID: id})
	return &(*routes)[len(*routes)-1]
}
