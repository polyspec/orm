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

	"github.com/polyspec/orm/engine/dialect"
	"github.com/polyspec/orm/engine/schema"
)

const Version = 1

// Request is one statement: a query (select/count/sum/avg), a write
// (insert/update/delete), or a paginate (select + count).
type Request struct {
	IRVersion  int    `json:"ir_version"`
	SchemaHash string `json:"schema_hash"`
	Kind       string `json:"kind"` // one all count group_count sum avg paginate insert update delete
	Query
	Set         []Assign `json:"set,omitempty"`
	OnDuplicate []Assign `json:"on_duplicate,omitempty"` // insert: assignments applied when the unique key already exists
	// Rows holds the parameters of each additional inserted row, in the
	// column order of Set. Every Set item is then a value assignment.
	Rows       [][]int   `json:"rows,omitempty"`
	Optimistic *Optimist `json:"optimistic,omitempty"`
	Agg        string    `json:"agg,omitempty"` // column for sum/avg
	// NParams is how many parameters the client holds. The engine only checks
	// indices against it; values never reach the engine.
	NParams int `json:"n_params"`
}

// Query is the shape shared by the root, join children and relation children.
type Query struct {
	Entity      string      `json:"entity"`
	Columns     *Columns    `json:"columns,omitempty"`
	On          *Group      `json:"on,omitempty"` // join children only
	Where       *Group      `json:"where,omitempty"`
	Joins       []*Join     `json:"joins,omitempty"`
	Relations   []*Relation `json:"relations,omitempty"`
	Order       []Order     `json:"order,omitempty"`
	GroupBy     []string    `json:"group_by,omitempty"`
	GroupByExpr []GroupExpr `json:"group_by_expr,omitempty"`
	Limit       *Limit      `json:"limit,omitempty"`
	ForceIdx    string      `json:"force_index,omitempty"`
	Lock        string      `json:"lock,omitempty"` // update, share, update_nowait or share_nowait; root row-select only

	// Relation-child options.
	KeyBy           string    `json:"key_by,omitempty"`
	Flatten         bool      `json:"flatten,omitempty"`
	LimitPerParent  int       `json:"limit_per_parent,omitempty"`
	IfParent        *IfParent `json:"if_parent,omitempty"`
	NoCascadeDelete bool      `json:"no_cascade_delete,omitempty"` // deleteCascade stops at this relation
}

type Columns struct {
	Mode   string             `json:"mode,omitempty"` // "" (default) | all | none
	Add    []string           `json:"add,omitempty"`
	Remove []string           `json:"remove,omitempty"`
	Expr   map[string]Expr    `json:"expr,omitempty"` // out name -> fragment
	Fn     map[string]ColFunc `json:"fn,omitempty"`   // out name -> column function
	Sub    map[string]*Sub    `json:"sub,omitempty"`  // out name -> scalar subquery
}

// Expr is a raw fragment with `{column}` references and `?` placeholders
// bound to the parameters in Ps.
type Expr struct {
	SQL string `json:"sql"`
	Ps  []int  `json:"ps,omitempty"`
}

// Func names an ORM function and its bound arguments.
type Func struct {
	Name string `json:"name"`
	Ps   []int  `json:"ps,omitempty"`
}

// ColFunc applies a column function to a column of the query's entity.
type ColFunc struct {
	Column string `json:"column"`
	Fn     Func   `json:"fn"`
}

// Sub is a subquery. Column selects one column (IN lists and scalar columns);
// Agg selects sum, avg, or count over Column for a scalar column. Refs with
// path "^" inside the subquery point at the enclosing query.
type Sub struct {
	Query  *Query `json:"query"`
	Column string `json:"column,omitempty"`
	Agg    string `json:"agg,omitempty"`
}

// Join adds a child table to the statement. Rel is the join name. Schema
// relations supply the keys unless Left and Right are set: Left is a column of
// the parent and Right a child column.
type Join struct {
	Rel   string `json:"rel"`
	Kind  string `json:"kind"` // inner | left
	Query *Query `json:"query"`
	Left  string `json:"left,omitempty"`
	Right string `json:"right,omitempty"`
}

// Relation loads rows in a separate statement. Rel is the result name. Schema
// relations supply keys and kind unless Left, Right and Kind are set.
type Relation struct {
	Rel   string `json:"rel"`
	Query *Query `json:"query"`
	Kind  string `json:"kind,omitempty"` // one | many
	Left  string `json:"left,omitempty"`
	Right string `json:"right,omitempty"`
}

// Group is a parenthesised list. Conn joins the group to its previous
// sibling; the first item of a group has no connector.
type Group struct {
	Conn  string `json:"conn,omitempty"` // and | or
	Items []Item `json:"items"`
}

// Item is exactly one of Pred, Group, Joined.
type Item struct {
	Pred   *Pred      `json:"pred,omitempty"`
	Group  *Group     `json:"group,omitempty"`
	Joined *JoinedRef `json:"joined,omitempty"`
}

// JoinedRef places the where conditions of the join named Join as a group.
type JoinedRef struct {
	Conn string `json:"conn,omitempty"`
	Join string `json:"join"`
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
	Fn     *Func    `json:"fn,omitempty"`    // column function applied to Column
	Value  *Func    `json:"value,omitempty"` // value function compared with Column
	Cols   []string `json:"cols,omitempty"`  // tuple_in, tuple_not_in columns; Ps holds the rows in order
	Sub    *Sub     `json:"sub,omitempty"`   // in, not_in subquery
}

// ColRef points at a column on another entity in the same statement:
// Path is the relation path from the root ("" = root, "campaign", "campaign/service").
type ColRef struct {
	Path   string `json:"path"`
	Column string `json:"column"`
}

type Order struct {
	Column string `json:"column,omitempty"`
	Expr   string `json:"expr,omitempty"`
	Desc   bool   `json:"desc,omitempty"`
	Random bool   `json:"random,omitempty"`
	Fn     *Func  `json:"fn,omitempty"` // column function applied to Column
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
	"string":   {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "contains_binary", "is_null", "is_not_null"},
	"text":     {"eq", "not_eq", "gt", "gte", "lt", "lte", "contains", "contains_binary", "is_null", "is_not_null"},
	"enum":     {"eq", "not_eq", "in", "not_in", "is_null", "is_not_null"},
	"bool":     {"eq", "not_eq", "is_null", "is_not_null"},
	"inet":     {"eq", "not_eq", "in", "not_in", "is_null", "is_not_null"},
	"bytes":    {"eq", "not_eq", "in", "not_in", "is_null", "is_not_null"},
	"jsontext": {"is_null", "is_not_null"},
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
	case "one", "all", "count", "group_count", "sum", "avg", "paginate", "insert", "update", "delete":
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
	switch r.Kind {
	case "sum", "avg":
		c := ent.Column(r.Agg)
		if c == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", r.Entity, r.Agg)
		}
		if c.Type != "i32" && c.Type != "i64" && c.Type != "f64" && c.Type != "decimal" {
			return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", r.Kind, r.Entity, r.Agg, c.Type)
		}
	}
	if r.Kind == "group_count" && !hasGroupBy(&r.Query) {
		return errf("IR_INVALID", "group_count needs group_by")
	}
	if r.Kind == "insert" || r.Kind == "update" {
		if len(r.Set) == 0 {
			return errf("IR_INVALID", "%s needs set[]", r.Kind)
		}
		for _, a := range r.Set {
			if err := v.assign(ent, r, &a); err != nil {
				return err
			}
		}
	}
	if len(r.Rows) > 0 {
		if r.Kind != "insert" || len(r.OnDuplicate) > 0 {
			return errf("IR_INVALID", "rows are only valid on insert without on_duplicate")
		}
		for _, a := range r.Set {
			if a.P == nil {
				return errf("IR_INVALID", "multi-row insert assigns %s.%s without a value", r.Entity, a.Column)
			}
		}
		for i, row := range r.Rows {
			if len(row) != len(r.Set) {
				return errf("IR_INVALID", "insert row %d has %d values for %d columns", i+1, len(row), len(r.Set))
			}
			if err := v.params(row); err != nil {
				return err
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
	m        *schema.Manifest
	n        int // NParams
	subDepth int // >0 while validating a subquery ("^" refs allowed)
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
	if q.Columns != nil {
		if q.Columns.Mode != "" && q.Columns.Mode != "all" && q.Columns.Mode != "none" {
			return errf("IR_INVALID", "columns.mode %q", q.Columns.Mode)
		}
		for _, c := range append(append([]string{}, q.Columns.Add...), q.Columns.Remove...) {
			if ent.Column(c) == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, c)
			}
		}
		// an output name is the row's key: two projections cannot claim the same one
		for out, e := range q.Columns.Expr {
			if ent.Column(out) != nil {
				return errf("COLUMN_ALIAS_CONFLICT", "%s.%s already a column", q.Entity, out)
			}
			if strings.Count(e.SQL, "?") != len(e.Ps) {
				return errf("IR_INVALID", "%s.%s expr has %d placeholders but %d binds", q.Entity, out, strings.Count(e.SQL, "?"), len(e.Ps))
			}
			if err := v.params(e.Ps); err != nil {
				return err
			}
		}
		outputs := map[string]bool{}
		for out := range q.Columns.Expr {
			outputs[out] = true
		}
		for out, cf := range q.Columns.Fn {
			if ent.Column(out) != nil || outputs[out] {
				return errf("COLUMN_ALIAS_CONFLICT", "%s.%s is already a row name", q.Entity, out)
			}
			outputs[out] = true
			col := ent.Column(cf.Column)
			if col == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, cf.Column)
			}
			if err := v.columnFunc(ent, col, &cf.Fn); err != nil {
				return err
			}
		}
		for out, sub := range q.Columns.Sub {
			if ent.Column(out) != nil || outputs[out] {
				return errf("COLUMN_ALIAS_CONFLICT", "%s.%s is already a row name", q.Entity, out)
			}
			outputs[out] = true
			if err := v.sub(sub, true); err != nil {
				return err
			}
		}
	}
	joined := map[string]*Join{}
	for _, j := range q.Joins {
		if j.Kind != "inner" && j.Kind != "left" {
			return errf("IR_INVALID", "join kind %q", j.Kind)
		}
		if _, dup := joined[j.Rel]; dup || j.Rel == "" {
			return errf("IR_INVALID", "join name %q is empty or used twice", j.Rel)
		}
		if j.Left != "" || j.Right != "" {
			if j.Left == "" || j.Right == "" || j.Query == nil {
				return errf("IR_INVALID", "join %s: left, right and query are required", j.Rel)
			}
			target, ok := v.m.Entities[j.Query.Entity]
			if !ok {
				return errf("ENTITY_UNKNOWN", "%s", j.Query.Entity)
			}
			if ent.Column(j.Left) == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, j.Left)
			}
			if target.Column(j.Right) == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", target.Name, j.Right)
			}
		} else {
			rel := ent.Relations[j.Rel]
			if rel == nil {
				return errf("RELATION_UNKNOWN", "%s.%s", q.Entity, j.Rel)
			}
			if j.Query == nil || j.Query.Entity != rel.Target {
				return errf("IR_INVALID", "join %s: query entity must be %s", j.Rel, rel.Target)
			}
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
		referenced := map[string]bool{}
		if err := joinedRefs(q.Where, joined, referenced); err != nil {
			return err
		}
	}
	relationNames := map[string]bool{}
	for _, r := range q.Relations {
		if r.Rel == "" || relationNames[r.Rel] {
			return errf("COLUMN_ALIAS_CONFLICT", "relation name %q is empty or used twice", r.Rel)
		}
		relationNames[r.Rel] = true
		if ent.Column(r.Rel) != nil {
			return errf("COLUMN_ALIAS_CONFLICT", "%s.%s is already a column", q.Entity, r.Rel)
		}
		if r.Query == nil {
			return errf("IR_INVALID", "relation %s needs a query", r.Rel)
		}
		kind := r.Kind
		if r.Left != "" || r.Right != "" {
			if r.Left == "" || r.Right == "" || (kind != "one" && kind != "many") {
				return errf("IR_INVALID", "relation %s: left, right and kind one|many are required", r.Rel)
			}
			target, ok := v.m.Entities[r.Query.Entity]
			if !ok {
				return errf("ENTITY_UNKNOWN", "%s", r.Query.Entity)
			}
			if ent.Column(r.Left) == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, r.Left)
			}
			if target.Column(r.Right) == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", target.Name, r.Right)
			}
		} else {
			rel := ent.Relations[r.Rel]
			if rel == nil {
				return errf("RELATION_UNKNOWN", "%s.%s", q.Entity, r.Rel)
			}
			if r.Query.Entity != rel.Target {
				return errf("IR_INVALID", "relation %s: query entity must be %s", r.Rel, rel.Target)
			}
			if kind != "" {
				return errf("IR_INVALID", "relation %s: kind needs left and right", r.Rel)
			}
			kind = rel.Kind
		}
		if r.Query.Limit != nil {
			return errf("LIMIT_IN_RELATION", "%s: use limit_per_parent", r.Rel)
		}
		if r.Query.Flatten && kind != "one" {
			return errf("IR_INVALID", "relation %s: flatten needs a one relation", r.Rel)
		}
		if r.Query.KeyBy != "" && kind != "many" {
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
	if !isRelation && (q.KeyBy != "" || q.Flatten || q.LimitPerParent > 0 || q.IfParent != nil || q.NoCascadeDelete) {
		return errf("IR_INVALID", "relation-only options on %s", q.Entity)
	}
	for _, o := range q.Order {
		kinds := 0
		for _, has := range []bool{o.Column != "", o.Expr != "", o.Random} {
			if has {
				kinds++
			}
		}
		if kinds != 1 {
			return errf("IR_INVALID", "order needs exactly one of column, expr, random")
		}
		if o.Column != "" {
			col := ent.Column(o.Column)
			if col == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, o.Column)
			}
			if o.Fn != nil {
				if err := v.columnFunc(ent, col, o.Fn); err != nil {
					return err
				}
			}
		} else if o.Fn != nil {
			return errf("IR_INVALID", "order function needs a column")
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
	if q.Lock != "" && q.Lock != "update" && q.Lock != "share" && q.Lock != "update_nowait" && q.Lock != "share_nowait" {
		return errf("IR_INVALID", "lock %q: want update, share, update_nowait or share_nowait", q.Lock)
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

// group validates connectors and operators.
func (v *validator) group(ent *schema.Entity, g *Group, joined map[string]*Join, top bool) error {
	for i, it := range g.Items {
		n := 0
		conn := ""
		if it.Pred != nil {
			n++
			conn = it.Pred.Conn
		}
		if it.Group != nil {
			n++
			conn = it.Group.Conn
		}
		if it.Joined != nil {
			n++
			conn = it.Joined.Conn
		}
		if n != 1 {
			return errf("IR_INVALID", "where item must be exactly one of pred/group/joined")
		}
		if conn != "" && conn != "and" && conn != "or" {
			return errf("IR_INVALID", "conn %q", conn)
		}
		if i == 0 && conn == "or" {
			return errf("OR_AT_GROUP_START", "a group may not start with OR")
		}
		switch {
		case it.Joined != nil:
			j, ok := joined[it.Joined.Join]
			if !ok {
				return errf("ENTITY_NOT_JOINED", "%s is not joined in this statement", it.Joined.Join)
			}
			if j.Query.Where == nil || len(j.Query.Where.Items) == 0 {
				return errf("IR_INVALID", "joined %s has no conditions", it.Joined.Join)
			}
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
	if p.Op == "tuple_in" || p.Op == "tuple_not_in" {
		if len(p.Cols) < 2 {
			return errf("IR_INVALID", "%s needs at least two columns", p.Op)
		}
		for _, name := range p.Cols {
			c := ent.Column(name)
			if c == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, name)
			}
			if len(c.Styles) > 0 || c.Type == "jsontext" || c.Type == "point" {
				return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s", p.Op, ent.Name, name)
			}
		}
		if len(p.Ps) == 0 {
			return errf("EMPTY_IN", "%s(%s)", ent.Name, strings.Join(p.Cols, ","))
		}
		if len(p.Ps)%len(p.Cols) != 0 {
			return errf("IR_INVALID", "%s: %d values for %d columns", p.Op, len(p.Ps), len(p.Cols))
		}
		return nil
	}
	if len(p.Cols) > 0 {
		return errf("IR_INVALID", "cols is only valid with tuple_in or tuple_not_in")
	}
	if p.Sub != nil {
		c := ent.Column(p.Column)
		if c == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, p.Column)
		}
		if p.Op != "in" && p.Op != "not_in" {
			return errf("IR_INVALID", "subquery needs in or not_in")
		}
		if p.P != nil || len(p.Ps) > 0 || p.Fn != nil || p.Value != nil {
			return errf("IR_INVALID", "subquery pred may not carry values")
		}
		return v.sub(p.Sub, false)
	}
	if p.Fn != nil || p.Value != nil {
		c := ent.Column(p.Column)
		if c == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, p.Column)
		}
		if p.Fn != nil && p.Value != nil {
			return errf("IR_INVALID", "fn and value cannot be combined")
		}
		if p.Fn != nil {
			if err := v.columnFunc(ent, c, p.Fn); err != nil {
				return err
			}
			switch p.Op {
			case "eq", "not_eq", "gt", "gte", "lt", "lte":
				if p.P == nil {
					return errf("IR_INVALID", "%s needs a value (p)", p.Op)
				}
			case "in", "not_in":
				if len(p.Ps) == 0 {
					return errf("EMPTY_IN", "%s.%s", ent.Name, p.Column)
				}
			case "between":
				if len(p.Ps) != 2 {
					return errf("IR_INVALID", "between needs 2 params (ps)")
				}
			default:
				return errf("OPERATOR_NOT_ALLOWED", "%s with a column function", p.Op)
			}
			return nil
		}
		if !dialect.IsValueFunction(p.Value.Name) {
			return errf("FUNCTION_UNKNOWN", "%s", p.Value.Name)
		}
		if c.Type != "date" && c.Type != "datetime" {
			return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", p.Value.Name, ent.Name, p.Column, c.Type)
		}
		want := 0
		if _, relative := dialect.ValueFunctionUnits[p.Value.Name]; relative {
			want = 1
		}
		if len(p.Value.Ps) != want {
			return errf("IR_INVALID", "%s takes %d arguments", p.Value.Name, want)
		}
		if p.P != nil || len(p.Ps) > 0 {
			return errf("IR_INVALID", "value function pred may not carry p or ps")
		}
		switch p.Op {
		case "eq", "not_eq", "gt", "gte", "lt", "lte":
		default:
			return errf("OPERATOR_NOT_ALLOWED", "%s with a value function", p.Op)
		}
		return v.params(p.Value.Ps)
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

// columnFunc validates a column function against the column type.
func (v *validator) columnFunc(ent *schema.Entity, c *schema.Col, f *Func) error {
	types, ok := dialect.ColumnFunctionTypes[f.Name]
	if !ok {
		return errf("FUNCTION_UNKNOWN", "%s", f.Name)
	}
	if !slices.Contains(types, c.Type) {
		return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", f.Name, ent.Name, c.Name, c.Type)
	}
	if len(f.Ps) != dialect.ColumnFunctionArity[f.Name] {
		return errf("IR_INVALID", "%s takes %d arguments", f.Name, dialect.ColumnFunctionArity[f.Name])
	}
	return v.params(f.Ps)
}

// sub validates a subquery; scalar subqueries accept an aggregate.
func (v *validator) sub(s *Sub, scalar bool) error {
	if s == nil || s.Query == nil {
		return errf("IR_INVALID", "subquery needs a query")
	}
	ent, ok := v.m.Entities[s.Query.Entity]
	if !ok {
		return errf("ENTITY_UNKNOWN", "%s", s.Query.Entity)
	}
	switch s.Agg {
	case "":
		if s.Column == "" {
			return errf("IR_INVALID", "subquery needs a column")
		}
	case "sum", "avg":
		if !scalar {
			return errf("IR_INVALID", "%s subquery is only valid as a column", s.Agg)
		}
		c := ent.Column(s.Column)
		if c == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, s.Column)
		}
		if c.Type != "i32" && c.Type != "i64" && c.Type != "f64" && c.Type != "decimal" {
			return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", s.Agg, ent.Name, s.Column, c.Type)
		}
	case "count":
		if !scalar {
			return errf("IR_INVALID", "count subquery is only valid as a column")
		}
	default:
		return errf("IR_INVALID", "subquery agg %q", s.Agg)
	}
	if s.Column != "" && ent.Column(s.Column) == nil {
		return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, s.Column)
	}
	if s.Query.Limit != nil || len(s.Query.Relations) > 0 || s.Query.Lock != "" || s.Query.Columns != nil {
		return errf("IR_INVALID", "subquery may not use limit, relations, lock or columns")
	}
	v.subDepth++
	defer func() { v.subDepth-- }()
	return v.query(s.Query, "", false, false)
}

// joinedRefs checks that each join referenced by a group appears once.
func joinedRefs(g *Group, joined map[string]*Join, seen map[string]bool) error {
	for _, it := range g.Items {
		if it.Joined != nil {
			if seen[it.Joined.Join] {
				return errf("IR_INVALID", "joined %s is placed twice", it.Joined.Join)
			}
			seen[it.Joined.Join] = true
		}
		if it.Group != nil {
			if err := joinedRefs(it.Group, joined, seen); err != nil {
				return err
			}
		}
	}
	return nil
}
