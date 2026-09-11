// Package ir defines the wire form clients send (JSON, docs/protocol.md) and
// validates it against the manifest. Validation is the only place the DSL's
// rules live; every client renders the same IR.
package ir

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/maxkwon/orm/engine/schema"
)

const Version = 1

// Request is one statement: a query (select/count/sum/avg), a write
// (insert/update/delete), or a paginate (select + count).
type Request struct {
	IRVersion  int    `json:"ir_version"`
	SchemaHash string `json:"schema_hash"`
	Kind       string `json:"kind"` // select one all count sum avg paginate insert update delete
	Query
	Set        []Assign  `json:"set,omitempty"`
	Optimistic *Optimist `json:"optimistic,omitempty"`
	Agg        string    `json:"agg,omitempty"` // column for sum/avg
	Debug      bool      `json:"debug,omitempty"`
}

// Query is the shape shared by the root, join children and relation children.
type Query struct {
	Entity    string      `json:"entity"`
	Columns   *Columns    `json:"columns,omitempty"`
	On        *Group      `json:"on,omitempty"` // join children only
	Where     *Group      `json:"where,omitempty"`
	Joins     []*Join     `json:"joins,omitempty"`
	Relations []*Relation `json:"relations,omitempty"`
	Order     []Order     `json:"order,omitempty"`
	GroupBy   []string    `json:"group_by,omitempty"`
	Limit     *Limit      `json:"limit,omitempty"`
	Distinct  bool        `json:"distinct,omitempty"`
	ForceIdx  string      `json:"force_index,omitempty"`

	// Relation-child options.
	KeyBy          string    `json:"key_by,omitempty"`
	Flatten        bool      `json:"flatten,omitempty"`
	LimitPerParent int       `json:"limit_per_parent,omitempty"`
	IfParent       *IfParent `json:"if_parent,omitempty"`
	DropChildKey   bool      `json:"drop_child_key,omitempty"`
}

type Columns struct {
	Mode   string            `json:"mode,omitempty"` // "" (default) | all | none
	Add    []string          `json:"add,omitempty"`
	Remove []string          `json:"remove,omitempty"`
	As     map[string]string `json:"as,omitempty"`   // out name -> column
	Expr   map[string]string `json:"expr,omitempty"` // out name -> fragment
}

type Join struct {
	Rel   string `json:"rel"`
	Kind  string `json:"kind"` // inner | left
	Query *Query `json:"query"`
}

type Relation struct {
	Rel   string `json:"rel"`
	Query *Query `json:"query"`
}

// Group is a parenthesised list. Conn joins the group to its previous
// sibling; the first item of a group has no connector.
type Group struct {
	Conn  string `json:"conn,omitempty"` // and | or
	Items []Item `json:"items"`
}

// Item is exactly one of Pred, Group, Nav.
type Item struct {
	Pred  *Pred  `json:"pred,omitempty"`
	Group *Group `json:"group,omitempty"`
	Nav   *Nav   `json:"nav,omitempty"`
}

type Pred struct {
	Conn   string            `json:"conn,omitempty"`
	Column string            `json:"column,omitempty"`
	Op     string            `json:"op,omitempty"`
	Value  json.RawMessage   `json:"value,omitempty"`
	Values []json.RawMessage `json:"values,omitempty"` // in, not_in, between
	Ref    *ColRef           `json:"ref,omitempty"`    // *_col operators
	Expr   string            `json:"expr,omitempty"`   // schema-checked fragment
	Binds  []json.RawMessage `json:"binds,omitempty"`
	Match  []string          `json:"match,omitempty"` // fulltext columns
}

// ColRef points at a column on another entity in the same statement:
// Path is the relation path from the root ("" = root, "campaign", "campaign/service").
type ColRef struct {
	Path   string `json:"path"`
	Column string `json:"column"`
}

// Nav descends into a joined relation inside a group.
type Nav struct {
	Conn  string `json:"conn,omitempty"`
	Rel   string `json:"rel"`
	Group *Group `json:"group"`
}

type Order struct {
	Column string `json:"column,omitempty"`
	Expr   string `json:"expr,omitempty"`
	Desc   bool   `json:"desc,omitempty"`
}

type Limit struct {
	Offset int `json:"offset"`
	Count  int `json:"count"`
}

type IfParent struct {
	Column string          `json:"column"`
	Value  json.RawMessage `json:"value"`
}

type Assign struct {
	Column string            `json:"column"`
	Value  json.RawMessage   `json:"value,omitempty"`
	Expr   string            `json:"expr,omitempty"`
	Binds  []json.RawMessage `json:"binds,omitempty"`
	Plus   json.RawMessage   `json:"plus,omitempty"`
	Minus  json.RawMessage   `json:"minus,omitempty"`
}

type Optimist struct {
	Column string          `json:"column"`
	Value  json.RawMessage `json:"value"`
}

// Error is a compile error with a stable code (docs/errors.yaml).
type Error struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Msg }

func errf(code, format string, a ...any) *Error { return &Error{code, fmt.Sprintf(format, a...)} }

// Operators by canonical column type. Fulltext is handled separately (needs an index).
var opsByType = map[string][]string{
	"i32":      {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"i64":      {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"f64":      {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"decimal":  {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"date":     {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"time":     {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"datetime": {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"string":   {"eq", "not_eq", "in", "not_in", "like", "like_binary", "contains", "starts_with", "ends_with", "is_null", "is_not_null"},
	"text":     {"eq", "not_eq", "like", "like_binary", "contains", "starts_with", "ends_with", "is_null", "is_not_null"},
	"enum":     {"eq", "not_eq", "in", "not_in", "is_null", "is_not_null"},
	"bool":     {"eq", "not_eq", "is_null", "is_not_null"},
	"inet":     {"eq", "not_eq", "in", "not_in", "is_null", "is_not_null"},
	"bytes":    {"is_null", "is_not_null"},
	"json":     {"is_null", "is_not_null"},
	"point":    {"is_null", "is_not_null"},
}

var colOps = map[string]bool{"eq_col": true, "not_eq_col": true, "gt_col": true, "gte_col": true, "lt_col": true, "lte_col": true}

// OpAllowed reports whether op is valid for a column of the given type/styles.
func OpAllowed(c *schema.Col, op string) bool {
	if colOps[op] || op == "expr" || op == "match" || op == "match_boolean" {
		return true
	}
	// Encoded columns: only equality (deterministic AES) or null checks.
	if len(c.Styles) > 0 && c.Type != "inet" {
		if c.Styles[0] == "aes" {
			return op == "eq" || op == "not_eq" || op == "in" || op == "not_in" || op == "is_null" || op == "is_not_null"
		}
		return op == "is_null" || op == "is_not_null"
	}
	for _, o := range opsByType[c.Type] {
		if o == op {
			return true
		}
	}
	return false
}

// Decode parses and validates a request against the manifest.
func Decode(m *schema.Manifest, b []byte) (*Request, error) {
	var r Request
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errf("IR_INVALID", "%v", err)
	}
	if r.IRVersion != Version {
		return nil, errf("VERSION_MISMATCH", "ir_version %d, engine %d", r.IRVersion, Version)
	}
	if r.SchemaHash != m.SchemaHash {
		return nil, errf("SCHEMA_HASH_MISMATCH", "client %s, engine %s", r.SchemaHash, m.SchemaHash)
	}
	switch r.Kind {
	case "one", "all", "count", "sum", "avg", "paginate", "insert", "update", "delete":
	default:
		return nil, errf("IR_INVALID", "unknown kind %q", r.Kind)
	}
	v := &validator{m: m}
	if err := v.query(&r.Query, "", false, false); err != nil {
		return nil, err
	}
	ent := m.Entities[r.Entity]
	if r.Kind == "sum" || r.Kind == "avg" {
		c := ent.Column(r.Agg)
		if c == nil {
			return nil, errf("COLUMN_UNKNOWN", "%s.%s", r.Entity, r.Agg)
		}
		if c.Type != "i32" && c.Type != "i64" && c.Type != "f64" && c.Type != "decimal" {
			return nil, errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", r.Kind, r.Entity, r.Agg, c.Type)
		}
	}
	if r.Kind == "insert" || r.Kind == "update" {
		if len(r.Set) == 0 {
			return nil, errf("IR_INVALID", "%s needs set[]", r.Kind)
		}
		for _, a := range r.Set {
			c := ent.Column(a.Column)
			if c == nil {
				return nil, errf("COLUMN_UNKNOWN", "%s.%s", r.Entity, a.Column)
			}
			n := 0
			for _, has := range []bool{len(a.Value) > 0, a.Expr != "", len(a.Plus) > 0, len(a.Minus) > 0} {
				if has {
					n++
				}
			}
			if n != 1 {
				return nil, errf("IR_INVALID", "set %s: exactly one of value/expr/plus/minus", a.Column)
			}
			if (len(a.Plus) > 0 || len(a.Minus) > 0) && c.Type != "i32" && c.Type != "i64" && c.Type != "f64" && c.Type != "decimal" {
				return nil, errf("OPERATOR_NOT_ALLOWED", "plus/minus on %s.%s (%s)", r.Entity, a.Column, c.Type)
			}
		}
	}
	if r.Optimistic != nil && ent.Column(r.Optimistic.Column) == nil {
		return nil, errf("COLUMN_UNKNOWN", "%s.%s", r.Entity, r.Optimistic.Column)
	}
	if (r.Kind == "update" || r.Kind == "delete") && (r.Where == nil || len(r.Where.Items) == 0) {
		return nil, errf("IR_INVALID", "%s without where", r.Kind)
	}
	return &r, nil
}

type validator struct {
	m *schema.Manifest
}

// query validates one Query and its subtrees. path is the relation path from
// the root; joined is the set of relation names joined at this level.
func (v *validator) query(q *Query, path string, isJoin, isRelation bool) error {
	ent, ok := v.m.Entities[q.Entity]
	if !ok {
		return errf("ENTITY_UNKNOWN", "%s", q.Entity)
	}
	if q.Columns != nil {
		if q.Columns.Mode != "" && q.Columns.Mode != "all" && q.Columns.Mode != "none" {
			return errf("IR_INVALID", "columns.mode %q", q.Columns.Mode)
		}
		for _, c := range append(append([]string{}, q.Columns.Add...), q.Columns.Remove...) {
			if ent.Column(c) == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, c)
			}
		}
		for out, c := range q.Columns.As {
			if ent.Column(c) == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, c)
			}
			if ent.Column(out) != nil {
				return errf("COLUMN_ALIAS_CONFLICT", "%s.%s already a column", q.Entity, out)
			}
		}
	}
	joined := map[string]*Join{}
	for _, j := range q.Joins {
		rel := ent.Relations[j.Rel]
		if rel == nil {
			return errf("RELATION_UNKNOWN", "%s.%s", q.Entity, j.Rel)
		}
		if j.Kind != "inner" && j.Kind != "left" {
			return errf("IR_INVALID", "join kind %q", j.Kind)
		}
		if j.Query == nil || j.Query.Entity != rel.Target {
			return errf("IR_INVALID", "join %s: query entity must be %s", j.Rel, rel.Target)
		}
		if _, dup := joined[j.Rel]; dup {
			return errf("IR_INVALID", "join %s twice", j.Rel)
		}
		joined[j.Rel] = j
		if err := v.query(j.Query, joinPath(path, j.Rel), true, false); err != nil {
			return err
		}
	}
	if !isJoin && q.On != nil {
		return errf("IR_INVALID", "on[] is only valid on join children")
	}
	if q.On != nil {
		if err := v.group(ent, q.On, joined, true); err != nil {
			return err
		}
	}
	if q.Where != nil {
		if err := v.group(ent, q.Where, joined, true); err != nil {
			return err
		}
	}
	for _, r := range q.Relations {
		rel := ent.Relations[r.Rel]
		if rel == nil {
			return errf("RELATION_UNKNOWN", "%s.%s", q.Entity, r.Rel)
		}
		if r.Query == nil || r.Query.Entity != rel.Target {
			return errf("IR_INVALID", "relation %s: query entity must be %s", r.Rel, rel.Target)
		}
		if r.Query.Limit != nil {
			return errf("LIMIT_IN_RELATION", "%s: use limit_per_parent", r.Rel)
		}
		if err := v.query(r.Query, joinPath(path, r.Rel), false, true); err != nil {
			return err
		}
	}
	if q.KeyBy != "" && ent.Column(q.KeyBy) == nil {
		return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, q.KeyBy)
	}
	if !isRelation && (q.KeyBy != "" || q.Flatten || q.LimitPerParent > 0 || q.IfParent != nil || q.DropChildKey) {
		return errf("IR_INVALID", "relation-only options on %s", q.Entity)
	}
	for _, o := range q.Order {
		if (o.Column == "") == (o.Expr == "") {
			return errf("IR_INVALID", "order needs column or expr")
		}
		if o.Column != "" && ent.Column(o.Column) == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, o.Column)
		}
	}
	for _, g := range q.GroupBy {
		if ent.Column(g) == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, g)
		}
	}
	if q.Limit != nil && (q.Limit.Offset < 0 || q.Limit.Count <= 0) {
		return errf("IR_INVALID", "limit offset>=0, count>0")
	}
	if q.ForceIdx != "" {
		if _, ok := ent.Indexes[q.ForceIdx]; !ok {
			return errf("INDEX_UNKNOWN", "%s.%s", q.Entity, q.ForceIdx)
		}
	}
	return nil
}

func joinPath(path, rel string) string {
	if path == "" {
		return rel
	}
	return path + "/" + rel
}

// group validates connectors, operators and navigation.
func (v *validator) group(ent *schema.Entity, g *Group, joined map[string]*Join, top bool) error {
	for i, it := range g.Items {
		n := 0
		conn := ""
		switch {
		case it.Pred != nil:
			n++
			conn = it.Pred.Conn
		case it.Group != nil:
			n++
			conn = it.Group.Conn
		case it.Nav != nil:
			n++
			conn = it.Nav.Conn
		}
		if n != 1 {
			return errf("IR_INVALID", "where item must be exactly one of pred/group/nav")
		}
		if conn != "" && conn != "and" && conn != "or" {
			return errf("IR_INVALID", "conn %q", conn)
		}
		if i == 0 && conn == "or" {
			return errf("OR_AT_GROUP_START", "a group may not start with OR")
		}
		switch {
		case it.Pred != nil:
			if err := v.pred(ent, it.Pred); err != nil {
				return err
			}
		case it.Group != nil:
			if len(it.Group.Items) == 0 {
				return errf("IR_INVALID", "empty group")
			}
			if err := v.group(ent, it.Group, joined, false); err != nil {
				return err
			}
		case it.Nav != nil:
			j, ok := joined[it.Nav.Rel]
			if !ok {
				return errf("ENTITY_NOT_JOINED", "%s.%s is not joined in this statement", ent.Name, it.Nav.Rel)
			}
			if it.Nav.Group == nil || len(it.Nav.Group.Items) == 0 {
				return errf("IR_INVALID", "empty nav group")
			}
			target := v.m.Entities[j.Query.Entity]
			nested := map[string]*Join{}
			for _, jj := range j.Query.Joins {
				nested[jj.Rel] = jj
			}
			if err := v.group(target, it.Nav.Group, nested, false); err != nil {
				return err
			}
		}
	}
	return nil
}

func (v *validator) pred(ent *schema.Entity, p *Pred) error {
	if p.Expr != "" {
		if p.Column != "" || p.Op != "" {
			return errf("IR_INVALID", "expr pred may not carry column/op")
		}
		return nil // fragment column names are checked by the dialect renderer
	}
	if p.Op == "match" || p.Op == "match_boolean" {
		if len(p.Match) == 0 {
			return errf("IR_INVALID", "match needs columns")
		}
		if !hasFulltext(ent, p.Match) {
			return errf("INDEX_UNKNOWN", "no fulltext index on %s(%s)", ent.Name, strings.Join(p.Match, ","))
		}
		if len(p.Value) == 0 {
			return errf("IR_INVALID", "match needs a value")
		}
		return nil
	}
	c := ent.Column(p.Column)
	if c == nil {
		return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, p.Column)
	}
	if !OpAllowed(c, p.Op) {
		return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", p.Op, ent.Name, p.Column, c.Type)
	}
	switch p.Op {
	case "is_null", "is_not_null":
	case "in", "not_in":
		if len(p.Values) == 0 {
			return errf("EMPTY_IN", "%s.%s", ent.Name, p.Column)
		}
	case "between":
		if len(p.Values) != 2 {
			return errf("IR_INVALID", "between needs 2 values")
		}
	default:
		if colOps[p.Op] {
			if p.Ref == nil {
				return errf("IR_INVALID", "%s needs ref", p.Op)
			}
			return nil
		}
		if len(p.Value) == 0 || string(p.Value) == "null" {
			return errf("IR_INVALID", "%s %s.%s needs a non-null value (use is_null)", p.Op, ent.Name, p.Column)
		}
	}
	return nil
}

func hasFulltext(ent *schema.Entity, cols []string) bool {
	for _, ft := range ent.Fulltext {
		if len(ft) != len(cols) {
			continue
		}
		ok := true
		for i := range ft {
			if ft[i] != cols[i] {
				ok = false
			}
		}
		if ok {
			return true
		}
	}
	return false
}
