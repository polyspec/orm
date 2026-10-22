// Package ir defines the wire form clients send (JSON, docs/spec/protocol.md) and
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

	"github.com/polyspec/orm/packages/go/engine/dialect"
	"github.com/polyspec/orm/packages/go/engine/internal/meet"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
)

const Version = 1

// Request is one statement: a query (select/count/sum/avg), a write
// (insert/update/delete/restore), or a paginate (select + count).
type Request struct {
	IRVersion int `json:"ir_version"`
	// ManifestHash is the manifestHash of the generated code that made the request.
	ManifestHash string `json:"manifest_hash"`
	Kind         string `json:"kind"` // one all count group_count sum avg paginate insert update delete restore restart_identity
	Query
	// Load means insert loads a row under the stored key as it is: it takes the value of the identity column,
	// and requires that value if the table has an identity. It is not used with on_duplicate.
	Load        bool     `json:"load,omitempty"`
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
	Entity    string      `json:"entity"`
	Columns   *Columns    `json:"columns,omitempty"`
	On        *Group      `json:"on,omitempty"` // join children only
	Where     *Group      `json:"where,omitempty"`
	Joins     []*Join     `json:"joins,omitempty"`
	Relations []*Relation `json:"relations,omitempty"`
	Order     []Order     `json:"order,omitempty"`
	GroupBy   []string    `json:"group_by,omitempty"`
	Limit     *Limit      `json:"limit,omitempty"`
	ForceIdx  string      `json:"force_index,omitempty"`
	Lock      string      `json:"lock,omitempty"` // update, share, update_nowait or share_nowait; root row-select only

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
	Fn     map[string]ColFunc `json:"fn,omitempty"`  // out name -> column function
	Sub    map[string]*Sub    `json:"sub,omitempty"` // out name -> scalar subquery
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

// Join adds a child table to the statement. Rel is the join name, and Left is
// the parent column, and Right is the child column.
type Join struct {
	Rel   string `json:"rel"`
	Kind  string `json:"kind"` // inner | left
	Query *Query `json:"query"`
	Left  string `json:"left,omitempty"`
	Right string `json:"right,omitempty"`
}

// Relation reads rows with a separate statement. Rel is the result name, and Left, Right,
// Kind decide the key and the kind.
type Relation struct {
	Rel   string    `json:"rel"`
	Query *Query    `json:"query"`
	Kind  string    `json:"kind,omitempty"` // one | many
	Keys  []KeyPair `json:"keys,omitempty"`
}

// KeyPair is one component of a relation key: the parent column Left and the child column Right
// are equal. A relation of a composite key holds one pair per component, in key order.
type KeyPair struct {
	Left  string `json:"left"`
	Right string `json:"right"`
}

// Group is a parenthesised list. Conn joins the group to its previous
// sibling; the first item of a group has no connector.
type Group struct {
	Conn string `json:"conn,omitempty"` // and | or
	// Not negates the whole nested group (`NOT (…)`). The top-level where and on groups are not negated.
	Not   bool   `json:"not,omitempty"`
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
	Ps     []int    `json:"ps,omitempty"`    // in, not_in, between, tuple rows
	Ref    *ColRef  `json:"ref,omitempty"`   // *_col operators
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
	Desc   bool   `json:"desc,omitempty"`
	Random bool   `json:"random,omitempty"`
	Fn     *Func  `json:"fn,omitempty"` // column function applied to Column
}

type Limit struct {
	Offset int `json:"offset"`
	Count  int `json:"count"`
}

type IfParent struct {
	Column string `json:"column"`
	P      int    `json:"p"`
}

// Assign sets one column: exactly one of P (value), PlusP, MinusP, Null.
type Assign struct {
	Column string `json:"column"`
	P      *int   `json:"p,omitempty"`
	Null   bool   `json:"null,omitempty"`
	PlusP  *int   `json:"plus_p,omitempty"`
	MinusP *int   `json:"minus_p,omitempty"`
}

type Optimist struct {
	Column string `json:"column"`
	P      int    `json:"p"`
}

// Error is a compile error with a stable code (docs/spec/errors.yaml).
type Error struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
	// Cause is a driver error from the driver code, or the callback error of ROLLBACK and a rollback
	// error. It is not included in the JSON form.
	Cause error `json:"-"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Msg }

// Unwrap returns Cause.
func (e *Error) Unwrap() error { return e.Cause }

func errf(code, format string, a ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, a...)}
}

// opsByType is the operators allowed for each dbspec type kind.
var opsByType = map[string][]string{
	"i16":      {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"i32":      {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"i64":      {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"f64":      {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"decimal":  {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"date":     {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"time":     {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"datetime": {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
	"varchar":  {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "contains_binary", "is_null", "is_not_null"},
	"uuid":     {"eq", "not_eq", "in", "not_in", "is_null", "is_not_null"},
	"text":     {"eq", "not_eq", "gt", "gte", "lt", "lte", "contains", "contains_binary", "is_null", "is_not_null"},
	"bool":     {"eq", "not_eq", "is_null", "is_not_null"},
	"bytes":    {"eq", "not_eq", "in", "not_in", "is_null", "is_not_null"},
}

// ipOps are the operators of a field whose codec is a single ip. Its values are address text.
var ipOps = []string{"eq", "not_eq", "in", "not_in", "is_null", "is_not_null"}

// numeric is a type kind that accepts plus, minus, sum, and avg.
func numeric(t string) bool {
	return t == "i16" || t == "i32" || t == "i64" || t == "f64" || t == "decimal"
}

var colOps = map[string]bool{"eq_col": true, "not_eq_col": true, "gt_col": true, "gte_col": true, "lt_col": true, "lte_col": true}

// assign validates one set[]/on_duplicate[] assignment.
func (v *validator) assign(ent *runtimemodel.Entity, r *Request, a *Assign) error {
	c := ent.Field(a.Column)
	if c == nil {
		return errf("COLUMN_UNKNOWN", "%s.%s", r.Entity, a.Column)
	}
	n := 0
	for _, has := range []bool{a.P != nil, a.Null, a.PlusP != nil, a.MinusP != nil} {
		if has {
			n++
		}
	}
	if n != 1 {
		return errf("IR_INVALID", "set %s: exactly one of p/null/plus_p/minus_p", a.Column)
	}
	if a.Null && !c.Null {
		return errf("IR_INVALID", "set %s.%s to null but column is NOT NULL", r.Entity, a.Column)
	}
	if (a.PlusP != nil || a.MinusP != nil) && (!numeric(c.Type) || len(c.Codec) > 0) {
		return errf("OPERATOR_NOT_ALLOWED", "plus/minus on %s.%s (%s)", r.Entity, a.Column, c.Type)
	}
	for _, idx := range []*int{a.P, a.PlusP, a.MinusP} {
		if idx != nil && (*idx < 0 || *idx >= r.NParams) {
			return errf("IR_INVALID", "param index %d out of range (n_params %d)", *idx, r.NParams)
		}
	}
	return nil
}

// OpAllowed reports whether op is allowed for the field's type and codec.
func OpAllowed(c *runtimemodel.Field, op string) bool {
	if colOps[op] {
		return true
	}
	// A codec field accepts address comparison if it is ip, blind index equality if it starts with aes, and otherwise only null checks.
	if len(c.Codec) > 0 {
		switch {
		case len(c.Codec) == 1 && c.Codec[0] == "ip":
			return slices.Contains(ipOps, op)
		case c.Codec[0] == "aes":
			return op == "eq" || op == "not_eq" || op == "in" || op == "not_in" || op == "is_null" || op == "is_not_null"
		}
		return op == "is_null" || op == "is_not_null"
	}
	return slices.Contains(opsByType[c.Type], op)
}

// Decode parses and validates a request against the manifest.
func Decode(m *runtimemodel.Model, b []byte) (*Request, error) {
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
func Validate(m *runtimemodel.Model, r *Request) error {
	if r.IRVersion != Version {
		return errf("VERSION_MISMATCH", "ir_version %d, engine %d", r.IRVersion, Version)
	}
	if r.ManifestHash != m.ManifestHash {
		return errf("SCHEMA_HASH_MISMATCH", "client %s, engine %s", r.ManifestHash, m.ManifestHash)
	}
	switch r.Kind {
	case "one", "all", "count", "group_count", "sum", "avg", "paginate", "insert", "update", "delete", "restore", "restart_identity":
	default:
		return errf("IR_INVALID", "unknown kind %q", r.Kind)
	}
	// A table of an external document is written only by the set that owns it (docs/spec/dbspec.md "External documents").
	if ent := m.Entities[r.Entity]; ent != nil && ent.External {
		switch r.Kind {
		case "insert", "update", "delete", "restore", "restart_identity":
			return errf("CONFIG", "%s is owned by another document set", ent.Table)
		}
	}
	if r.Load && (r.Kind != "insert" || len(r.OnDuplicate) > 0) {
		return errf("IR_INVALID", "load is only valid on insert without on_duplicate")
	}
	// restart_identity restarts only one entity's identity, so it takes no row or value.
	if r.Kind == "restart_identity" && (len(r.Set) > 0 || len(r.Rows) > 0 || len(r.OnDuplicate) > 0 || r.Where != nil || r.Optimistic != nil) {
		return errf("IR_INVALID", "restart_identity takes no set, rows, on_duplicate, where or optimistic")
	}
	v := &validator{m: m, n: r.NParams, root: &r.Query}
	if err := v.query(&r.Query, v.scopes(&r.Query, nil, nil), false, false); err != nil {
		return err
	}
	if r.Lock != "" && r.Kind != "one" && r.Kind != "all" {
		return errf("IR_INVALID", "row lock is only valid on one or all")
	}
	ent := m.Entities[r.Entity]
	switch r.Kind {
	case "sum", "avg":
		c := ent.Field(r.Agg)
		if c == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", r.Entity, r.Agg)
		}
		if !numeric(c.Type) || len(c.Codec) > 0 {
			return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", r.Kind, r.Entity, r.Agg, c.Type)
		}
	}
	if r.Kind == "group_count" && !hasGroupBy(&r.Query) {
		return errf("IR_INVALID", "group_count needs group_by")
	}
	if hasGroupBy(&r.Query) && r.Kind != "count" && r.Kind != "group_count" {
		return errf("IR_INVALID", "group_by is only valid on count or group_count, not %s", r.Kind)
	}
	if r.Kind == "insert" || r.Kind == "update" || r.Kind == "restore" {
		if len(r.Set) == 0 && r.Kind != "restore" {
			return errf("IR_INVALID", "%s needs set[]", r.Kind)
		}
		for _, a := range r.Set {
			if err := v.assign(ent, r, &a); err != nil {
				return err
			}
			// A VALUES list has no current row for plus_p or minus_p to read; on_duplicate does.
			if r.Kind == "insert" && (a.PlusP != nil || a.MinusP != nil) {
				return errf("IR_INVALID", "insert cannot assign %s by plus or minus", a.Column)
			}
			// The key is the table's own. A restore checks its set with its key below.
			if r.Kind == "update" {
				if c := ent.Field(a.Column); c.PrimaryKey || c.Identity {
					return errf("IR_INVALID", "cannot update %s", a.Column)
				}
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
			if c := ent.Field(a.Column); c.PrimaryKey || c.Identity {
				return errf("IR_INVALID", "on_duplicate cannot assign %s.%s", r.Entity, a.Column)
			}
		}
		if _, err := ConflictKey(ent, r.Set); err != nil {
			return err
		}
	}
	if r.Optimistic != nil {
		if ent.Field(r.Optimistic.Column) == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", r.Entity, r.Optimistic.Column)
		}
		if err := v.params([]int{r.Optimistic.P}); err != nil {
			return err
		}
	}
	if (r.Kind == "update" || r.Kind == "delete") && (r.Where == nil || len(r.Where.Items) == 0) {
		return errf("IR_INVALID", "%s without where", r.Kind)
	}
	if r.Kind == "restore" {
		// restore fixes only deleted rows, so there is no read version to compare with.
		if r.Optimistic != nil {
			return errf("IR_INVALID", "restore takes no optimistic")
		}
		if _, err := RestoreKey(ent, r); err != nil {
			return err
		}
	}
	return nil
}

type validator struct {
	m    *runtimemodel.Model
	n    int    // NParams
	root *Query // the request's own query: the only one that may group
}

// scope is one entity position in a statement (the statement's root or a join), like the planner's scope
// that resolves the ref path of a column-to-column condition. A relation and a subquery are the root of their own statement.
type scope struct {
	name   string
	ent    *runtimemodel.Entity // nil if the entity is not in the manifest
	parent *scope               // the parent of a join. nil for the statement's root
	outer  *scope               // the scope of the query enclosing a subquery root ("^" ref)
	joins  map[string]*scope
}

// scopes builds the scope tree of q and its joins. As the planner's buildScopes does, before checking where
// it includes every join, so a condition also resolves paths of joins declared later.
func (v *validator) scopes(q *Query, parent, outer *scope) *scope {
	s := &scope{name: q.Entity, ent: v.m.Entities[q.Entity], parent: parent, outer: outer, joins: map[string]*scope{}}
	for _, j := range q.Joins {
		if _, dup := s.joins[j.Rel]; dup || j.Query == nil {
			continue
		}
		s.joins[j.Rel] = v.scopes(j.Query, s, nil)
	}
	return s
}

// ref resolves a ref of a column-to-column condition, as the planner's resolvePath does. Path "" is the statement's root,
// "^" is the query enclosing a subquery and is used only inside a subquery. Other paths are join names joined from the root
// with "/". The target entity must have the ref's column.
func (v *validator) ref(s *scope, r *ColRef) (*runtimemodel.Field, error) {
	root := s
	for root.parent != nil {
		root = root.parent
	}
	target := root
	switch r.Path {
	case "":
	case "^":
		if root.outer == nil {
			return nil, errf("IR_INVALID", "^ reference outside a subquery")
		}
		target = root.outer
	default:
		for _, seg := range strings.Split(r.Path, "/") {
			next, ok := target.joins[seg]
			if !ok {
				return nil, errf("ENTITY_NOT_JOINED", "%s.%s", target.name, seg)
			}
			target = next
		}
	}
	if target.ent == nil {
		return nil, errf("ENTITY_UNKNOWN", "%s", target.name)
	}
	c := target.ent.Field(r.Column)
	if c == nil {
		return nil, errf("COLUMN_UNKNOWN", "%s.%s", target.name, r.Column)
	}
	return c, nil
}

// ConflictKey returns the one key an insert with on_duplicate conflicts on. MySQL updates the row met on any unique
// key, while PostgreSQL and SQLite name one target and a meeting on another key is a unique violation, so no order of
// keys reproduces both: an upsert has exactly one key that can meet the inserted row, and the insert assigns every
// column of it. The candidates are the primary key, unless the insert leaves it out (an identity, or a key an IR
// executor assigns), and each unique key; a blind index column counts as assigned with its AES source.
func ConflictKey(ent *runtimemodel.Entity, set []Assign) (runtimemodel.Key, error) {
	assigned := map[string]bool{}
	for _, a := range set {
		assigned[a.Column] = true
	}
	for _, f := range ent.Fields {
		if f.BlindIndex != "" && assigned[f.Name] {
			assigned[f.BlindIndex] = true
		}
	}
	var candidates []runtimemodel.Key
	for _, c := range ent.PK {
		if assigned[c] {
			candidates = append(candidates, runtimemodel.Key{Name: "primary key (" + strings.Join(ent.PK, ", ") + ")", Columns: ent.PK})
			break
		}
	}
	for _, u := range ent.Uniques {
		candidates = append(candidates, runtimemodel.Key{Name: "unique (" + strings.Join(u.Columns, ", ") + ")", Columns: u.Columns})
	}
	if len(candidates) == 0 {
		return runtimemodel.Key{}, errf("IR_INVALID", "on_duplicate needs exactly one conflict key; no key can meet the row")
	}
	if len(candidates) != 1 {
		names := make([]string, len(candidates))
		for i, k := range candidates {
			names[i] = k.Name
		}
		return runtimemodel.Key{}, errf("IR_INVALID", "on_duplicate needs exactly one conflict key; %s can meet the row", strings.Join(names, ", "))
	}
	for _, c := range candidates[0].Columns {
		if !assigned[c] {
			return runtimemodel.Key{}, errf("IR_INVALID", "on_duplicate needs exactly one conflict key; %s can meet the row but the insert does not assign %s", candidates[0].Name, c)
		}
	}
	return candidates[0], nil
}

// RestoreParts are the parts of the statement of a restore request: the key that names its row, the
// conditions and the new values.
type RestoreParts struct {
	// Key is the primary key, or the unique key, whose columns the request gives values.
	Key []string
	// Where is the where of the request with an eq condition for each set value of a key column.
	Where Group
	// Set holds the set values of the columns outside the key: the new values of the row.
	Set []Assign
}

// RestoreKey picks the key of a restore request (docs/spec/protocol.md 1.5) after the request hook. The set
// values with a parameter and the eq conditions with a parameter that the where joins with and give
// columns their values; the key is the primary key when they cover it, otherwise the first unique key
// in name order that they cover. A set value of a key column becomes a condition, every other set value
// is a new value, and the where keeps its other conditions, which narrow the restore further; the key
// still names at most one row.
func RestoreKey(ent *runtimemodel.Entity, r *Request) (RestoreParts, error) {
	if ent.SoftDelete == "" {
		return RestoreParts{}, errf("IR_INVALID", "restore of %s, which has no soft_delete setting", ent.Name)
	}
	var items []Item
	if r.Where != nil {
		items = r.Where.Items
	}
	valued := map[string]bool{}
	for i, item := range items {
		if i > 0 && ItemConn(item) == "or" {
			return RestoreParts{}, errf("IR_INVALID", "restore of %s joins the conditions of its where with and", ent.Name)
		}
		if pr := item.Pred; pr != nil && pr.Op == "eq" && pr.P != nil && pr.Fn == nil && pr.Value == nil && pr.Ref == nil && pr.Sub == nil {
			valued[pr.Column] = true
		}
	}
	for _, a := range r.Set {
		if a.P != nil {
			valued[a.Column] = true
		}
	}
	covered := func(columns []string) bool {
		return len(columns) > 0 && !slices.ContainsFunc(columns, func(c string) bool { return !valued[c] })
	}
	var key []string
	if covered(ent.PK) {
		key = ent.PK
	} else if i := slices.IndexFunc(ent.Uniques, func(k runtimemodel.Key) bool { return covered(k.Columns) }); i >= 0 {
		key = ent.Uniques[i].Columns
	}
	if key == nil {
		return RestoreParts{}, errf("IR_INVALID", "restore of %s gives no primary key or unique key a value in its set or in an eq condition of its where", ent.Name)
	}
	parts := RestoreParts{Key: key, Where: Group{Items: slices.Clone(items)}}
	for _, a := range r.Set {
		if a.P != nil && slices.Contains(key, a.Column) {
			p := *a.P
			pred := &Pred{Column: a.Column, Op: "eq", P: &p}
			if len(parts.Where.Items) > 0 {
				pred.Conn = "and"
			}
			parts.Where.Items = append(parts.Where.Items, Item{Pred: pred})
			continue
		}
		// The key and the soft delete column are the table's own: a restore clears the latter itself.
		if c := ent.Field(a.Column); c.PrimaryKey || c.Identity || a.Column == ent.SoftDelete {
			return RestoreParts{}, errf("IR_INVALID", "restore cannot assign %s", a.Column)
		}
		parts.Set = append(parts.Set, a)
	}
	return parts, nil
}

// listOperandError is the error of an in or between predicate whose params
// (ps) do not fit its operator: an in list is not empty, and between has two.
func listOperandError(ent *runtimemodel.Entity, p *Pred) error {
	switch p.Op {
	case "in", "not_in":
		if len(p.Ps) == 0 {
			return errf("EMPTY_IN", "%s.%s", ent.Name, p.Column)
		}
	case "between":
		if len(p.Ps) != 2 {
			return errf("IR_INVALID", "between needs 2 params (ps)")
		}
	}
	return nil
}

// ItemConn is the connector that joins an item to the item before it.
func ItemConn(item Item) string {
	switch {
	case item.Pred != nil:
		return item.Pred.Conn
	case item.Group != nil:
		return item.Group.Conn
	case item.Joined != nil:
		return item.Joined.Conn
	}
	return ""
}

// meets reports whether two columns compare alike on the three databases, by the table that dbspec's check operands
// also read (meet.Kind).
func meets(a, b *runtimemodel.Field) bool {
	return meet.Kind(a.Type, a.Scale, a.Precision) == meet.Kind(b.Type, b.Scale, b.Precision)
}

// colPairOpAllowed reports whether the column comparison op may compare the columns left and right: its base operator
// (eq for eq_col) must be one of the left column's type, and neither column may have a codec, since a codec's stored
// form is not the value the operator orders. Two columns whose only codec is ip compare by eq_col and not_eq_col,
// because both sides are the dialect's same stored form.
func colPairOpAllowed(left, right *runtimemodel.Field, op string) bool {
	base := strings.TrimSuffix(op, "_col")
	if len(left.Codec) == 0 && len(right.Codec) == 0 {
		return slices.Contains(opsByType[left.Type], base)
	}
	isIP := func(f *runtimemodel.Field) bool { return len(f.Codec) == 1 && f.Codec[0] == "ip" }
	return isIP(left) && isIP(right) && (base == "eq" || base == "not_eq")
}

func (v *validator) params(ps []int) error {
	for _, i := range ps {
		if i < 0 || i >= v.n {
			return errf("IR_INVALID", "param index %d out of range (n_params %d)", i, v.n)
		}
	}
	return nil
}

// query validates one Query and its subtrees. s is the scope of q in its
// statement (v.scopes), against which column-to-column refs resolve.
func (v *validator) query(q *Query, s *scope, isJoin, isRelation bool) error {
	ent, ok := v.m.Entities[q.Entity]
	if !ok {
		return errf("ENTITY_UNKNOWN", "%s", q.Entity)
	}
	if q.Columns != nil {
		if q.Columns.Mode != "" && q.Columns.Mode != "all" && q.Columns.Mode != "none" {
			return errf("IR_INVALID", "columns.mode %q", q.Columns.Mode)
		}
		for _, c := range append(append([]string{}, q.Columns.Add...), q.Columns.Remove...) {
			if ent.Field(c) == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, c)
			}
		}
		// an output name is the row's key: two projections cannot claim the same one
		outputs := map[string]bool{}
		for out, cf := range q.Columns.Fn {
			if ent.Field(out) != nil || outputs[out] {
				return errf("COLUMN_ALIAS_CONFLICT", "%s.%s is already a row name", q.Entity, out)
			}
			outputs[out] = true
			col := ent.Field(cf.Column)
			if col == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, cf.Column)
			}
			if err := v.columnFunc(ent, col, &cf.Fn); err != nil {
				return err
			}
		}
		for out, sub := range q.Columns.Sub {
			if ent.Field(out) != nil || outputs[out] {
				return errf("COLUMN_ALIAS_CONFLICT", "%s.%s is already a row name", q.Entity, out)
			}
			outputs[out] = true
			if err := v.sub(sub, true, s); err != nil {
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
		if j.Left == "" || j.Right == "" || j.Query == nil {
			return errf("IR_INVALID", "join %s: left, right and query are required", j.Rel)
		}
		target, ok := v.m.Entities[j.Query.Entity]
		if !ok {
			return errf("ENTITY_UNKNOWN", "%s", j.Query.Entity)
		}
		if ent.Field(j.Left) == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, j.Left)
		}
		if target.Field(j.Right) == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", target.Name, j.Right)
		}
		if !meets(ent.Field(j.Left), target.Field(j.Right)) {
			return errf("OPERATOR_NOT_ALLOWED", "join %s: %s.%s (%s) does not meet %s.%s (%s)", j.Rel, ent.Name, j.Left, ent.Field(j.Left).Type, target.Name, j.Right, target.Field(j.Right).Type)
		}
		joined[j.Rel] = j
		if err := v.query(j.Query, s.joins[j.Rel], true, false); err != nil {
			return err
		}
	}
	if !isJoin && q.On != nil {
		return errf("IR_INVALID", "on[] is only valid on join children")
	}
	if q.On != nil {
		if err := v.group(s, q.On, joined, true); err != nil {
			return err
		}
	}
	if q.Where != nil {
		if err := v.group(s, q.Where, joined, true); err != nil {
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
		if ent.Field(r.Rel) != nil {
			return errf("COLUMN_ALIAS_CONFLICT", "%s.%s is already a column", q.Entity, r.Rel)
		}
		if r.Query == nil {
			return errf("IR_INVALID", "relation %s needs a query", r.Rel)
		}
		kind := r.Kind
		if len(r.Keys) == 0 || (kind != "one" && kind != "many") {
			return errf("IR_INVALID", "relation %s: keys and kind one|many are required", r.Rel)
		}
		target, ok := v.m.Entities[r.Query.Entity]
		if !ok {
			return errf("ENTITY_UNKNOWN", "%s", r.Query.Entity)
		}
		lefts, rights := map[string]bool{}, map[string]bool{}
		for _, k := range r.Keys {
			if k.Left == "" || k.Right == "" {
				return errf("IR_INVALID", "relation %s: every key needs left and right", r.Rel)
			}
			if ent.Field(k.Left) == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, k.Left)
			}
			if target.Field(k.Right) == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", target.Name, k.Right)
			}
			if !meets(ent.Field(k.Left), target.Field(k.Right)) {
				return errf("OPERATOR_NOT_ALLOWED", "relation %s: %s.%s (%s) does not meet %s.%s (%s)", r.Rel, q.Entity, k.Left, ent.Field(k.Left).Type, target.Name, k.Right, target.Field(k.Right).Type)
			}
			// If one column appears in both components, it is not a key.
			if lefts[k.Left] || rights[k.Right] {
				return errf("IR_INVALID", "relation %s: key column %s or %s is used twice", r.Rel, k.Left, k.Right)
			}
			lefts[k.Left], rights[k.Right] = true, true
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
		if r.Query.IfParent != nil && ent.Field(r.Query.IfParent.Column) == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s (if_parent)", q.Entity, r.Query.IfParent.Column)
		}
		if err := v.query(r.Query, v.scopes(r.Query, nil, nil), false, true); err != nil {
			return err
		}
	}
	if q.KeyBy != "" {
		col := ent.Field(q.KeyBy)
		if col == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, q.KeyBy)
		}
		// A NULL collection key has no answer that every language shares.
		if col.Null {
			return errf("IR_INVALID", "key_by %s is nullable", q.KeyBy)
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
		for _, has := range []bool{o.Column != "", o.Random} {
			if has {
				kinds++
			}
		}
		if kinds != 1 {
			return errf("IR_INVALID", "order needs exactly one of column, random")
		}
		if o.Column != "" {
			col := ent.Field(o.Column)
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
		if ent.Field(g) == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", q.Entity, g)
		}
	}
	if len(q.GroupBy) > 0 {
		if q != v.root {
			return errf("IR_INVALID", "group_by is only valid on the request's root query")
		}
		// An order item of a grouped query sorts the groups: only a group column (or random) has a value per group.
		for _, o := range q.Order {
			if o.Column != "" && !slices.Contains(q.GroupBy, o.Column) {
				return errf("IR_INVALID", "order by %s, which is not a group column", o.Column)
			}
		}
	}
	if q.Limit != nil && (q.Limit.Offset < 0 || q.Limit.Count <= 0) {
		return errf("IR_INVALID", "limit offset>=0, count>0")
	}
	if q.Lock != "" && q.Lock != "update" && q.Lock != "share" && q.Lock != "update_nowait" && q.Lock != "share_nowait" {
		return errf("IR_INVALID", "lock %q: want update, share, update_nowait or share_nowait", q.Lock)
	}
	if q.Lock != "" && (isJoin || isRelation || q.GroupBy != nil || q.LimitPerParent > 0) {
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
	return len(q.GroupBy) > 0
}

// group validates connectors and operators. A top-level group (where, on) has
// no previous sibling and the first item of a group none either, so neither
// takes a connector.
func (v *validator) group(s *scope, g *Group, joined map[string]*Join, top bool) error {
	if top && g.Not {
		return errf("IR_INVALID", "not applies to a nested group")
	}
	if top && g.Conn != "" {
		return errf("IR_INVALID", "the top-level group takes no conn (%q)", g.Conn)
	}
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
		if i == 0 && conn != "" {
			return errf("IR_INVALID", "the first item of a group takes no conn (%q)", conn)
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
			if err := v.pred(s, it.Pred); err != nil {
				return err
			}
		case it.Group != nil:
			if len(it.Group.Items) == 0 {
				return errf("IR_INVALID", "empty group")
			}
			if err := v.group(s, it.Group, joined, false); err != nil {
				return err
			}
		}
	}
	return nil
}

func (v *validator) pred(s *scope, p *Pred) error {
	ent := s.ent
	if err := v.params(p.Ps); err != nil {
		return err
	}
	if p.P != nil {
		if err := v.params([]int{*p.P}); err != nil {
			return err
		}
	}
	if p.Op == "tuple_in" || p.Op == "tuple_not_in" {
		if len(p.Cols) < 2 {
			return errf("IR_INVALID", "%s needs at least two columns", p.Op)
		}
		for _, name := range p.Cols {
			c := ent.Field(name)
			if c == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, name)
			}
			if len(c.Codec) > 0 {
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
	if p.Op == "fulltext" || p.Op == "fulltext_boolean" {
		if len(p.Cols) == 0 || p.P == nil || p.Column != "" || len(p.Ps) > 0 || p.Ref != nil || p.Fn != nil || p.Value != nil || p.Sub != nil {
			return errf("IR_INVALID", "%s takes cols and p only", p.Op)
		}
		for _, name := range p.Cols {
			c := ent.Field(name)
			if c == nil {
				return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, name)
			}
			if (c.Type != "varchar" && c.Type != "text") || len(c.Codec) > 0 {
				return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s", p.Op, ent.Name, name)
			}
		}
		return nil
	}
	if len(p.Cols) > 0 {
		return errf("IR_INVALID", "cols is only valid with tuple_in or tuple_not_in")
	}
	if p.Sub != nil {
		c := ent.Field(p.Column)
		if c == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, p.Column)
		}
		if p.Op != "in" && p.Op != "not_in" {
			return errf("IR_INVALID", "subquery needs in or not_in")
		}
		if p.P != nil || len(p.Ps) > 0 || p.Fn != nil || p.Value != nil {
			return errf("IR_INVALID", "subquery pred may not carry values")
		}
		if err := v.sub(p.Sub, false, s); err != nil {
			return err
		}
		// sub checked the subquery column; it meets the compared column as check operands do.
		if sc := v.m.Entities[p.Sub.Query.Entity].Field(p.Sub.Column); sc != nil && !meets(c, sc) {
			return errf("OPERATOR_NOT_ALLOWED", "%s.%s (%s) %s a subquery of %s.%s (%s)", ent.Name, p.Column, c.Type, p.Op, p.Sub.Query.Entity, p.Sub.Column, sc.Type)
		}
		return nil
	}
	if p.Fn != nil || p.Value != nil {
		c := ent.Field(p.Column)
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
			case "in", "not_in", "between":
				return listOperandError(ent, p)
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
	c := ent.Field(p.Column)
	if c == nil {
		return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, p.Column)
	}
	if !OpAllowed(c, p.Op) {
		return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", p.Op, ent.Name, p.Column, c.Type)
	}
	switch p.Op {
	case "is_null", "is_not_null":
	case "in", "not_in", "between":
		if err := listOperandError(ent, p); err != nil {
			return err
		}
	default:
		if colOps[p.Op] {
			if p.Ref == nil {
				return errf("IR_INVALID", "%s needs ref", p.Op)
			}
			other, err := v.ref(s, p.Ref)
			if err != nil {
				return err
			}
			if !meets(c, other) {
				return errf("OPERATOR_NOT_ALLOWED", "%s.%s (%s) does not meet %s.%s (%s)", ent.Name, p.Column, c.Type, p.Ref.Path, p.Ref.Column, other.Type)
			}
			if !colPairOpAllowed(c, other, p.Op) {
				return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s) and %s.%s (%s)", p.Op, ent.Name, p.Column, c.Type, p.Ref.Path, p.Ref.Column, other.Type)
			}
			return nil
		}
		if p.P == nil {
			return errf("IR_INVALID", "%s %s.%s needs a value (p)", p.Op, ent.Name, p.Column)
		}
	}
	return nil
}

// columnFunc validates a column function against the column type.
func (v *validator) columnFunc(ent *runtimemodel.Entity, c *runtimemodel.Field, f *Func) error {
	types, ok := dialect.ColumnFunctionTypes[f.Name]
	if !ok {
		return errf("FUNCTION_UNKNOWN", "%s", f.Name)
	}
	if !slices.Contains(types, c.Type) || len(c.Codec) > 0 {
		return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", f.Name, ent.Name, c.Name, c.Type)
	}
	if len(f.Ps) != dialect.ColumnFunctionArity[f.Name] {
		return errf("IR_INVALID", "%s takes %d arguments", f.Name, dialect.ColumnFunctionArity[f.Name])
	}
	return v.params(f.Ps)
}

// sub validates a subquery; scalar subqueries accept an aggregate. outer is
// the scope the subquery appears in, which its "^" refs name.
func (v *validator) sub(s *Sub, scalar bool, outer *scope) error {
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
		c := ent.Field(s.Column)
		if c == nil {
			return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, s.Column)
		}
		if !numeric(c.Type) || len(c.Codec) > 0 {
			return errf("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", s.Agg, ent.Name, s.Column, c.Type)
		}
	case "count":
		if !scalar {
			return errf("IR_INVALID", "count subquery is only valid as a column")
		}
	default:
		return errf("IR_INVALID", "subquery agg %q", s.Agg)
	}
	if s.Column != "" && ent.Field(s.Column) == nil {
		return errf("COLUMN_UNKNOWN", "%s.%s", ent.Name, s.Column)
	}
	// A scalar column subquery yields at most one row by its shape: MySQL answers 1242 and PostgreSQL 21000 for
	// several rows, and SQLite returns the first, so the request makes one row certain. An in subquery (MySQL 1235)
	// and an aggregate take no limit.
	scalarColumn := scalar && s.Agg == ""
	if len(s.Query.Relations) > 0 || s.Query.Lock != "" || s.Query.Columns != nil || s.Query.Limit != nil && !scalarColumn {
		return errf("IR_INVALID", "subquery may not use limit, relations, lock or columns")
	}
	if scalarColumn {
		if s.Query.Limit == nil || s.Query.Limit.Count != 1 {
			return errf("IR_INVALID", "a scalar column subquery needs limit with count 1")
		}
		for _, pk := range ent.PK {
			found := false
			for _, o := range s.Query.Order {
				if o.Random {
					return errf("IR_INVALID", "a scalar column subquery may not order by random")
				}
				if o.Column == pk && o.Fn == nil {
					found = true
				}
			}
			if !found {
				return errf("IR_INVALID", "a scalar column subquery needs an order that includes the primary key column %s", pk)
			}
		}
	}
	return v.query(s.Query, v.scopes(s.Query, nil, outer), false, false)
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
