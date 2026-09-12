// Package ir defines the wire form clients send (JSON, docs/protocol.md) and
// validates it against the manifest. Validation is the only place the DSL's
// rules live; every client renders the same IR.
package ir

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

const Version = 1

// Request is one statement: a query (select/count/sum/avg), a write
// (insert/update/delete), or a paginate (select + count).
type Request struct {
	IRVersion  int    `json:"ir_version"`
	SchemaHash string `json:"schema_hash"`
	Kind       string `json:"kind"` // one all count group_count count_distinct sum avg min max paginate insert update delete
	Query
	Set         []Assign  `json:"set,omitempty"`
	OnDuplicate []Assign  `json:"on_duplicate,omitempty"` // insert: assignments applied when the unique key already exists
	Optimistic  *Optimist `json:"optimistic,omitempty"`
	Agg         string    `json:"agg,omitempty"` // column for sum/avg/min/max/count_distinct
	Raw         *Raw      `json:"raw,omitempty"` // kind raw: a hand-written SELECT (trusted code only)
	Debug       bool      `json:"debug,omitempty"`
	// NParams is how many parameters the client holds. The engine only checks
	// indices against it; values never reach the engine.
	NParams int `json:"n_params"`
}

// Query is the shape shared by the root, join children and relation children.
type Query struct {
	Entity      string      `json:"entity"`
	ScopeP      *int        `json:"scope_p,omitempty"` // parameter for the entity's declared tenant scope
	Columns     *Columns    `json:"columns,omitempty"`
	On          *Group      `json:"on,omitempty"` // join children only
	Where       *Group      `json:"where,omitempty"`
	Having      *Group      `json:"having,omitempty"` // group predicates (needs group_by); expr items may use aggregates
	Joins       []*Join     `json:"joins,omitempty"`
	Relations   []*Relation `json:"relations,omitempty"`
	Order       []Order     `json:"order,omitempty"`
	GroupBy     []string    `json:"group_by,omitempty"`
	GroupByExpr []GroupExpr `json:"group_by_expr,omitempty"`
	Limit       *Limit      `json:"limit,omitempty"`
	Distinct    bool        `json:"distinct,omitempty"`
	ForceIdx    string      `json:"force_index,omitempty"`
	Lock        string      `json:"lock,omitempty"`   // update or share; root row-select only
	Keyset      *Keyset     `json:"keyset,omitempty"` // root keyset boundary; values reference Request.Params

	// Relation-child options.
	KeyBy           string    `json:"key_by,omitempty"`
	Flatten         bool      `json:"flatten,omitempty"`
	LimitPerParent  int       `json:"limit_per_parent,omitempty"`
	IfParent        *IfParent `json:"if_parent,omitempty"`
	DropChildKey    bool      `json:"drop_child_key,omitempty"`
	NoCascadeDelete bool      `json:"no_cascade_delete,omitempty"` // deleteCascade stops at this relation
}

// Keyset is a value-free cursor boundary. Order is taken from Query.Order;
// Values contains parameter indexes in that same order. The planner appends
// missing primary-key columns to make the ordering total.
type Keyset struct {
	Direction string `json:"direction"` // after | before
	Values    []int  `json:"values"`
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

// Values never travel inside the tree: a predicate references parameters by
// index (P, Ps) into the request's Params list. The plan is therefore
// value-independent and executors fill placeholders from their own Params.
type Pred struct {
	Conn   string   `json:"conn,omitempty"`
	Column string   `json:"column,omitempty"`
	Op     string   `json:"op,omitempty"`
	P      *int     `json:"p,omitempty"`     // single value
	Ps     []int    `json:"ps,omitempty"`    // in, not_in, between, expr binds
	Ref    *ColRef  `json:"ref,omitempty"`   // *_col operators
	Expr   string   `json:"expr,omitempty"`  // schema-checked fragment
	Match  []string `json:"match,omitempty"` // fulltext columns
}

// ColRef points at a column on another entity in the same statement:
// Path is the relation path from the root ("" = root, "campaign", "campaign/service").
type ColRef struct {
	Path   string `json:"path"`
	Column string `json:"column"`
}

// Nav descends into a joined relation inside a group.
type Nav struct {
	Conn    string `json:"conn,omitempty"`
	Rel     string `json:"rel"`
	Group   *Group `json:"group"`
	Mode    string `json:"mode,omitempty"`     // "" = joined navigation, exists, or not_exists
	CountOp string `json:"count_op,omitempty"` // count mode: eq, not_eq, gt, gte, lt, lte
	P       *int   `json:"p,omitempty"`        // count comparison parameter
}

type Order struct {
	Column string `json:"column,omitempty"`
	Expr   string `json:"expr,omitempty"`
	Desc   bool   `json:"desc,omitempty"`
}

// GroupExpr is a trusted SQL expression used as a grouping key. As is the
// output name exposed on the grouped row; backtick column names in Expr are
// checked and qualified by the planner.
type GroupExpr struct {
	Expr string `json:"expr"`
	As   string `json:"as"`
}

type Limit struct {
	Offset int `json:"offset"`
	Count  int `json:"count"`
}

type IfParent struct {
	Column string `json:"column"`
	P      int    `json:"p"`
}

// Assign sets one column: exactly one of P (value), Expr(+Ps binds), PlusP, MinusP, Null.
type Assign struct {
	Column string `json:"column"`
	P      *int   `json:"p,omitempty"`
	Null   bool   `json:"null,omitempty"`
	Expr   string `json:"expr,omitempty"`
	Ps     []int  `json:"ps,omitempty"`
	PlusP  *int   `json:"plus_p,omitempty"`
	MinusP *int   `json:"minus_p,omitempty"`
}

// Raw is a hand-written statement run as the root: `{table}` is replaced by the
// entity's quoted table, each `?` is bound from Ps in order. Rows come back by
// column name (no assembly), so this is the escape hatch, not the grammar.
type Raw struct {
	SQL string `json:"sql"`
	Ps  []int  `json:"ps,omitempty"`
}

type Optimist struct {
	Column string `json:"column"`
	P      int    `json:"p"`
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

// assign validates one set[]/on_duplicate[] assignment.
func (v *validator) assign(ent *schema.Entity, r *Request, a *Assign) error {
	c := ent.Column(a.Column)
	if c == nil {
		return errf("COLUMN_UNKNOWN", "%s.%s", r.Entity, a.Column)
	}
	n := 0
	for _, has := range []bool{a.P != nil, a.Null, a.Expr != "", a.PlusP != nil, a.MinusP != nil} {
		if has {
			n++
		}
	}
	if n != 1 {
		return errf("IR_INVALID", "set %s: exactly one of p/null/expr/plus_p/minus_p", a.Column)
	}
	if a.Null && !c.Nullable {
		return errf("IR_INVALID", "set %s.%s to null but column is NOT NULL", r.Entity, a.Column)
	}
	if (a.PlusP != nil || a.MinusP != nil) && c.Type != "i32" && c.Type != "i64" && c.Type != "f64" && c.Type != "decimal" {
		return errf("OPERATOR_NOT_ALLOWED", "plus/minus on %s.%s (%s)", r.Entity, a.Column, c.Type)
	}
	for _, idx := range []*int{a.P, a.PlusP, a.MinusP} {
		if idx != nil && (*idx < 0 || *idx >= r.NParams) {
			return errf("IR_INVALID", "param index %d out of range (n_params %d)", *idx, r.NParams)
		}
	}
	return v.params(a.Ps)
}

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
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&r); err != nil {
		return nil, errf("IR_INVALID", "%v", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errf("IR_INVALID", "expected exactly one request object")
	}
	if err := Validate(m, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// Validate checks an already-built request (in-process Go clients skip JSON).
func Validate(m *schema.Manifest, r *Request) error {
	if r.IRVersion != Version {
		return errf("VERSION_MISMATCH", "ir_version %d, engine %d", r.IRVersion, Version)
	}
	if r.SchemaHash != m.SchemaHash {
		return errf("SCHEMA_HASH_MISMATCH", "client %s, engine %s", r.SchemaHash, m.SchemaHash)
	}
	switch r.Kind {
	case "one", "all", "count", "group_count", "count_distinct", "sum", "avg", "min", "max", "paginate", "insert", "update", "delete", "raw":
	default:
		return errf("IR_INVALID", "unknown kind %q", r.Kind)
	}
	v := &validator{m: m, n: r.NParams}
	if err := v.query(&r.Query, "", false, false); err != nil {
		return err
	}
	if r.Query.Lock != "" && r.Kind != "one" && r.Kind != "all" {
		return errf("IR_INVALID", "row lock is only valid on one or all")
	}
	ent := m.Entities[r.Entity]
	if r.ScopeP != nil && r.Kind == "raw" {
		return errf("IR_INVALID", "scope cannot be applied to raw SQL")
	}
	switch r.Kind {
	case "sum", "avg":
		c := ent.Column(r.Agg)
		if c == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", r.Entity, r.Agg)
		}
		if c.Type != "i32" && c.Type != "i64" && c.Type != "f64" && c.Type != "decimal" {
			return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", r.Kind, r.Entity, r.Agg, c.Type)
		}
	case "min", "max", "count_distinct":
		c := ent.Column(r.Agg)
		if c == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", r.Entity, r.Agg)
		}
		if len(c.Styles) > 0 && c.Styles[0] != "ip" || c.Type == "json" || c.Type == "bytes" {
			return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", r.Kind, r.Entity, r.Agg, c.Type)
		}
	}
	if r.Having != nil && !hasGroupBy(&r.Query) {
		return errf("IR_INVALID", "having needs group_by")
	}
	if r.Kind == "group_count" && !hasGroupBy(&r.Query) {
		return errf("IR_INVALID", "group_count needs group_by")
	}
	if r.Kind == "raw" {
		if r.Raw == nil || strings.TrimSpace(r.Raw.SQL) == "" {
			return errf("IR_INVALID", "raw needs raw.sql")
		}
		if n := strings.Count(r.Raw.SQL, "?"); n != len(r.Raw.Ps) {
			return errf("IR_INVALID", "raw: %d placeholders but %d params", n, len(r.Raw.Ps))
		}
		if err := v.params(r.Raw.Ps); err != nil {
			return err
		}
	} else if r.Raw != nil {
		return errf("IR_INVALID", "raw is only valid with kind raw")
	}
	if r.Kind == "insert" || r.Kind == "update" {
		if len(r.Set) == 0 {
			return errf("IR_INVALID", "%s needs set[]", r.Kind)
		}
		for _, a := range r.Set {
			if err := v.assign(ent, r, &a); err != nil {
				return err
			}
			if r.ScopeP != nil && a.Column == ent.Scope {
				if r.Kind != "insert" || a.P == nil || *a.P != *r.ScopeP {
					return errf("IR_INVALID", "scoped %s cannot assign %s.%s from a different parameter", r.Kind, r.Entity, ent.Scope)
				}
			}
		}
	}
	if len(r.OnDuplicate) > 0 {
		if r.Kind != "insert" {
			return errf("IR_INVALID", "on_duplicate is only valid on insert")
		}
		for _, a := range r.OnDuplicate {
			if err := v.assign(ent, r, &a); err != nil {
				return err
			}
			if c := ent.Column(a.Column); c.PK || c.Auto {
				return errf("IR_INVALID", "on_duplicate cannot assign %s.%s", r.Entity, a.Column)
			}
			if r.ScopeP != nil && a.Column == ent.Scope {
				return errf("IR_INVALID", "scoped upsert cannot update %s.%s", r.Entity, ent.Scope)
			}
		}
	}
	if r.Optimistic != nil {
		if ent.Column(r.Optimistic.Column) == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", r.Entity, r.Optimistic.Column)
		}
		if err := v.params([]int{r.Optimistic.P}); err != nil {
			return err
		}
	}
	if (r.Kind == "update" || r.Kind == "delete") && (r.Where == nil || len(r.Where.Items) == 0) {
		return errf("IR_INVALID", "%s without where", r.Kind)
	}
	return nil
}

type validator struct {
	m *schema.Manifest
	n int // NParams
}

func (v *validator) params(ps []int) error {
	for _, i := range ps {
		if i < 0 || i >= v.n {
			return errf("IR_INVALID", "param index %d out of range (n_params %d)", i, v.n)
		}
	}
	return nil
}

// query validates one Query and its subtrees. path is the relation path from
// the root; joined is the set of relation names joined at this level.
func (v *validator) query(q *Query, path string, isJoin, isRelation bool) error {
	ent, ok := v.m.Entities[q.Entity]
	if !ok {
		return errf("ENTITY_UNKNOWN", "%s", q.Entity)
	}
	if q.ScopeP != nil {
		if ent.Scope == "" {
			return errf("IR_INVALID", "scope is not declared for %s", q.Entity)
		}
		if err := v.params([]int{*q.ScopeP}); err != nil {
			return err
		}
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
		// an output name is the row's key: two projections cannot claim the same one
		for out := range q.Columns.Expr {
			if ent.Column(out) != nil {
				return errf("COLUMN_ALIAS_CONFLICT", "%s.%s already a column", q.Entity, out)
			}
			if _, dup := q.Columns.As[out]; dup {
				return errf("COLUMN_ALIAS_CONFLICT", "%s.%s is both an alias and an expr output", q.Entity, out)
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
	if q.Having != nil {
		if isJoin || isRelation {
			return errf("IR_INVALID", "having is only valid on the root query")
		}
		if err := v.group(ent, q.Having, joined, true); err != nil {
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
		if r.Query.Flatten && rel.Kind != "one" {
			return errf("IR_INVALID", "relation %s: flatten needs a one relation", r.Rel)
		}
		if r.Query.KeyBy != "" && rel.Kind != "many" {
			return errf("IR_INVALID", "relation %s: key_by needs a many relation", r.Rel)
		}
		if r.Query.IfParent != nil && ent.Column(r.Query.IfParent.Column) == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s (if_parent)", q.Entity, r.Query.IfParent.Column)
		}
		if err := v.query(r.Query, joinPath(path, r.Rel), false, true); err != nil {
			return err
		}
	}
	if q.KeyBy != "" {
		col := ent.Column(q.KeyBy)
		if col == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, q.KeyBy)
		}
	}
	if q.IfParent != nil {
		if err := v.params([]int{q.IfParent.P}); err != nil {
			return err
		}
	}
	if q.Keyset != nil {
		if isJoin || isRelation {
			return errf("IR_INVALID", "keyset is only valid on the root query")
		}
		if err := v.params(q.Keyset.Values); err != nil {
			return err
		}
	}
	if !isRelation && (q.KeyBy != "" || q.Flatten || q.LimitPerParent > 0 || q.IfParent != nil || q.DropChildKey || q.NoCascadeDelete) {
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
	seenGroups := make(map[string]bool, len(q.GroupBy)+len(q.GroupByExpr))
	for _, g := range q.GroupBy {
		seenGroups[g] = true
	}
	for _, g := range q.GroupByExpr {
		if strings.TrimSpace(g.Expr) == "" || strings.TrimSpace(g.As) == "" {
			return errf("IR_INVALID", "group_by_expr needs expr and as")
		}
		if strings.Contains(g.Expr, "?") {
			return errf("IR_INVALID", "group_by_expr does not accept parameters")
		}
		if seenGroups[g.As] {
			return errf("IR_INVALID", "duplicate group output %s", g.As)
		}
		seenGroups[g.As] = true
	}
	if q.Limit != nil && (q.Limit.Offset < 0 || q.Limit.Count <= 0) {
		return errf("IR_INVALID", "limit offset>=0, count>0")
	}
	if q.Lock != "" && q.Lock != "update" && q.Lock != "share" {
		return errf("IR_INVALID", "lock %q: want update or share", q.Lock)
	}
	if q.Lock != "" && (isJoin || isRelation || q.GroupBy != nil || q.GroupByExpr != nil || q.LimitPerParent > 0) {
		return errf("IR_INVALID", "row lock is only valid on a root row select")
	}
	if q.ForceIdx != "" {
		if _, ok := ent.Indexes[q.ForceIdx]; !ok {
			return errf("INDEX_UNKNOWN", "%s.%s", q.Entity, q.ForceIdx)
		}
	}
	return nil
}

func hasGroupBy(q *Query) bool {
	return len(q.GroupBy) > 0 || len(q.GroupByExpr) > 0
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
			var target *schema.Entity
			if it.Nav.Mode == "" {
				j, ok := joined[it.Nav.Rel]
				if !ok {
					return errf("ENTITY_NOT_JOINED", "%s.%s is not joined in this statement", ent.Name, it.Nav.Rel)
				}
				target = v.m.Entities[j.Query.Entity]
			} else {
				if it.Nav.Mode != "exists" && it.Nav.Mode != "not_exists" && it.Nav.Mode != "count" {
					return errf("IR_INVALID", "navigation mode %q", it.Nav.Mode)
				}
				if it.Nav.Mode == "count" {
					if it.Nav.P == nil || !slices.Contains([]string{"eq", "not_eq", "gt", "gte", "lt", "lte"}, it.Nav.CountOp) {
						return errf("IR_INVALID", "count navigation needs a comparison operator and parameter")
					}
					if err := v.params([]int{*it.Nav.P}); err != nil {
						return err
					}
				}
				rel := ent.Relations[it.Nav.Rel]
				if rel == nil {
					return errf("RELATION_UNKNOWN", "%s.%s", ent.Name, it.Nav.Rel)
				}
				target = v.m.Entities[rel.Target]
			}
			if it.Nav.Mode == "" && (it.Nav.Group == nil || len(it.Nav.Group.Items) == 0) {
				return errf("IR_INVALID", "empty nav group")
			}
			if it.Nav.Group == nil {
				continue
			}
			nested := map[string]*Join{}
			if it.Nav.Mode == "" {
				j := joined[it.Nav.Rel]
				for _, jj := range j.Query.Joins {
					nested[jj.Rel] = jj
				}
			}
			if err := v.group(target, it.Nav.Group, nested, false); err != nil {
				return err
			}
		}
	}
	return nil
}

func (v *validator) pred(ent *schema.Entity, p *Pred) error {
	if err := v.params(p.Ps); err != nil {
		return err
	}
	if p.P != nil {
		if err := v.params([]int{*p.P}); err != nil {
			return err
		}
	}
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
		if p.P == nil {
			return errf("IR_INVALID", "match needs a value (p)")
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
		if len(p.Ps) == 0 {
			return errf("EMPTY_IN", "%s.%s", ent.Name, p.Column)
		}
	case "between":
		if len(p.Ps) != 2 {
			return errf("IR_INVALID", "between needs 2 params (ps)")
		}
	default:
		if colOps[p.Op] {
			if p.Ref == nil {
				return errf("IR_INVALID", "%s needs ref", p.Op)
			}
			return nil
		}
		if p.P == nil {
			return errf("IR_INVALID", "%s %s.%s needs a value (p)", p.Op, ent.Name, p.Column)
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
