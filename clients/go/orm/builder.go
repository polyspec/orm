package orm

import (
	"context"
	"fmt"
	"time"

	"github.com/maxkwon/orm/engine"
	"github.com/maxkwon/orm/engine/ir"
	"github.com/maxkwon/orm/engine/plan"
)

// Q is the untyped core of a generated query builder: the request, the query
// node this builder edits (root, join child or relation child) and the
// pending connector for the next WHERE item.
type Q struct {
	Req       *Req
	Node      *ir.Query
	pendingOr bool
}

func NewQ(eng *engine.Engine, entity string) *Q {
	r := NewReq(eng, "all", entity)
	return &Q{Req: r, Node: &r.IR.Query}
}

func (q *Q) where() *ir.Group {
	if q.Node.Where == nil {
		q.Node.Where = &ir.Group{}
	}
	return q.Node.Where
}

func (q *Q) on() *ir.Group {
	if q.Node.On == nil {
		q.Node.On = &ir.Group{}
	}
	return q.Node.On
}

// W edits one group (root where, a nested group, an ON group, or a nav group).
type W struct {
	Req       *Req
	G         *ir.Group
	pendingOr bool
}

func NewW(req *Req, g *ir.Group) *W { return &W{Req: req, G: g} }

func (w *W) conn() string {
	if w.pendingOr {
		w.pendingOr = false
		return "or"
	}
	return ""
}

func (w *W) Or() { w.pendingOr = true }

func (w *W) Pred(col, op string, v any) {
	i := w.Req.P(v)
	w.G.Items = append(w.G.Items, ir.Item{Pred: &ir.Pred{Conn: w.conn(), Column: col, Op: op, P: &i}})
}

func (w *W) PredList(col, op string, vs []any) {
	ps := make([]int, 0, len(vs))
	for _, v := range vs {
		ps = append(ps, w.Req.P(v))
	}
	w.G.Items = append(w.G.Items, ir.Item{Pred: &ir.Pred{Conn: w.conn(), Column: col, Op: op, Ps: ps}})
}

func (w *W) PredNull(col, op string) {
	w.G.Items = append(w.G.Items, ir.Item{Pred: &ir.Pred{Conn: w.conn(), Column: col, Op: op}})
}

// ColRef names a column of another entity in the same statement for
// column-to-column predicates: Path "" is the parent (inside on()/where() of a
// join child) or the root; At("service") / At("campaign/service") walks joins.
type ColRef struct {
	Path   string
	Column string
}

func (c ColRef) At(path string) ColRef { return ColRef{Path: path, Column: c.Column} }

func (w *W) PredCol(col, op, path, refCol string) {
	w.G.Items = append(w.G.Items, ir.Item{Pred: &ir.Pred{Conn: w.conn(), Column: col, Op: op, Ref: &ir.ColRef{Path: path, Column: refCol}}})
}

func (w *W) Match(cols []string, boolean bool, v string) {
	op := "match"
	if boolean {
		op = "match_boolean"
	}
	i := w.Req.P(v)
	w.G.Items = append(w.G.Items, ir.Item{Pred: &ir.Pred{Conn: w.conn(), Op: op, Match: cols, P: &i}})
}

func (w *W) Expr(frag string, binds ...any) {
	ps := make([]int, 0, len(binds))
	for _, v := range binds {
		ps = append(ps, w.Req.P(v))
	}
	w.G.Items = append(w.G.Items, ir.Item{Pred: &ir.Pred{Conn: w.conn(), Expr: frag, Ps: ps}})
}

// And opens a parenthesised group; fn receives a W over the new group.
func (w *W) And(fn func(*W)) {
	g := &ir.Group{Conn: w.conn()}
	w.G.Items = append(w.G.Items, ir.Item{Group: g})
	fn(NewW(w.Req, g))
}

// Nav descends into a joined relation.
func (w *W) Nav(rel string, fn func(*W)) {
	g := &ir.Group{}
	w.G.Items = append(w.G.Items, ir.Item{Nav: &ir.Nav{Conn: w.conn(), Rel: rel, Group: g}})
	fn(NewW(w.Req, g))
}

// Root-level WHERE helpers on Q delegate to a W over the root where group,
// carrying the pending connector across calls.
func (q *Q) W() *W {
	w := NewW(q.Req, q.where())
	w.pendingOr = q.pendingOr
	q.pendingOr = false
	return w
}

func (q *Q) Or() { q.pendingOr = true }

func (q *Q) OnW() *W { return NewW(q.Req, q.on()) }

// HavingW edits the root HAVING group (the engine requires group_by with it).
func (q *Q) HavingW() *W {
	if q.Node.Having == nil {
		q.Node.Having = &ir.Group{}
	}
	return NewW(q.Req, q.Node.Having)
}

// Raw stores a hand-written SELECT as the request's root (kind raw): `{table}`
// is the entity's table, each `?` binds the next value. RawAll runs it.
func (q *Q) Raw(sql string, binds ...any) {
	ps := make([]int, 0, len(binds))
	for _, v := range binds {
		ps = append(ps, q.Req.P(v))
	}
	q.Req.IR.Raw = &ir.Raw{SQL: sql, Ps: ps}
}

func (q *Q) Join(rel, kind string, child *Q) {
	q.Node.Joins = append(q.Node.Joins, &ir.Join{Rel: rel, Kind: kind, Query: q.Req.Attach(child.Req)})
}

func (q *Q) Relation(rel string, child *Q) {
	q.Node.Relations = append(q.Node.Relations, &ir.Relation{Rel: rel, Query: q.Req.Attach(child.Req)})
}

func (q *Q) Columns() *ir.Columns {
	if q.Node.Columns == nil {
		q.Node.Columns = &ir.Columns{}
	}
	return q.Node.Columns
}

func (q *Q) Order(col string, desc bool) {
	q.Node.Order = append(q.Node.Order, ir.Order{Column: col, Desc: desc})
}

func (q *Q) OrderExpr(frag string, desc bool) {
	q.Node.Order = append(q.Node.Order, ir.Order{Expr: frag, Desc: desc})
}

func (q *Q) Set(col string, v any) {
	i := q.Req.P(v)
	q.Req.IR.Set = append(q.Req.IR.Set, ir.Assign{Column: col, P: &i})
}

// SetStyled encodes v with the column's styles (docs/codec.md) before binding
// it; an encode error is kept on the request and surfaces from the terminal.
func (q *Q) SetStyled(col string, v any, styles []string) {
	enc, err := Encode(styles, v)
	if err != nil {
		if q.Req.Err == nil {
			q.Req.Err = err
		}
		return
	}
	if enc == nil {
		q.SetNull(col)
		return
	}
	q.Set(col, enc)
}

func (q *Q) SetNull(col string) {
	q.Req.IR.Set = append(q.Req.IR.Set, ir.Assign{Column: col, Null: true})
}

func (q *Q) SetExpr(col, frag string, binds ...any) {
	ps := make([]int, 0, len(binds))
	for _, v := range binds {
		ps = append(ps, q.Req.P(v))
	}
	q.Req.IR.Set = append(q.Req.IR.Set, ir.Assign{Column: col, Expr: frag, Ps: ps})
}

func (q *Q) Plus(col string, v any) {
	i := q.Req.P(v)
	q.Req.IR.Set = append(q.Req.IR.Set, ir.Assign{Column: col, PlusP: &i})
}

func (q *Q) Minus(col string, v any) {
	i := q.Req.P(v)
	q.Req.IR.Set = append(q.Req.IR.Set, ir.Assign{Column: col, MinusP: &i})
}

func (q *Q) IfParent(col string, v any) {
	q.Node.IfParent = &ir.IfParent{Column: col, P: q.Req.P(v)}
}

// OnDuplicate* mirror Set*/Plus/Minus into the insert's ON DUPLICATE KEY UPDATE list.
func (q *Q) OnDuplicate(col string, v any) {
	i := q.Req.P(v)
	q.Req.IR.OnDuplicate = append(q.Req.IR.OnDuplicate, ir.Assign{Column: col, P: &i})
}

// OnDuplicateStyled encodes like SetStyled; nil stays a NULL assignment.
func (q *Q) OnDuplicateStyled(col string, v any, styles []string) {
	enc, err := Encode(styles, v)
	if err != nil {
		if q.Req.Err == nil {
			q.Req.Err = err
		}
		return
	}
	if enc == nil {
		q.Req.IR.OnDuplicate = append(q.Req.IR.OnDuplicate, ir.Assign{Column: col, Null: true})
		return
	}
	q.OnDuplicate(col, enc)
}

func (q *Q) OnDuplicateExpr(col, frag string, binds ...any) {
	ps := make([]int, 0, len(binds))
	for _, v := range binds {
		ps = append(ps, q.Req.P(v))
	}
	q.Req.IR.OnDuplicate = append(q.Req.IR.OnDuplicate, ir.Assign{Column: col, Expr: frag, Ps: ps})
}

func (q *Q) OnDuplicatePlus(col string, v any) {
	i := q.Req.P(v)
	q.Req.IR.OnDuplicate = append(q.Req.IR.OnDuplicate, ir.Assign{Column: col, PlusP: &i})
}

func (q *Q) OnDuplicateMinus(col string, v any) {
	i := q.Req.P(v)
	q.Req.IR.OnDuplicate = append(q.Req.IR.OnDuplicate, ir.Assign{Column: col, MinusP: &i})
}

// OnDuplicateSetAll copies the assignments made so far (the PK/auto columns
// named in exclude aside) so a duplicate key updates the row to the same
// values. Copies share the params: the plan binds each value twice.
func (q *Q) OnDuplicateSetAll(exclude ...string) {
	skip := map[string]bool{}
	for _, c := range exclude {
		skip[c] = true
	}
	for _, a := range q.Req.IR.Set {
		if !skip[a.Column] {
			q.Req.IR.OnDuplicate = append(q.Req.IR.OnDuplicate, a)
		}
	}
}

// MovePKToWhere turns a draft into an update of the other assigned columns
// when the PK was assigned a value: that assignment becomes WHERE pk = value
// and the value is returned. ok is false (and nothing changes) when the PK is
// not in set[] — the insert branch of save.
func (q *Q) MovePKToWhere(pk string) (v any, ok bool) {
	for i, a := range q.Req.IR.Set {
		if a.Column != pk || a.P == nil {
			continue
		}
		v = q.Req.Params[*a.P]
		q.Req.IR.Set = append(q.Req.IR.Set[:i:i], q.Req.IR.Set[i+1:]...)
		q.W().Pred(pk, "eq", v)
		return v, true
	}
	return nil, false
}

// Row is embedded in every generated row struct: it remembers where the row
// came from and which columns were changed through Set* so Update sends only those.
type Row struct {
	entity string
	pk     string
	pkVal  any
	loaded bool
	dirty  []ir.Assign
	dvals  []any
	encErr error // first codec error from DirtyStyled; surfaces from UpdateRow
	extra  map[string]any // selectExpr / select<Col>As outputs, by output name

	// assembly facts generated scanners record for ToArray
	selected []string        // output names present in this row's projection, in order
	hidden   map[string]bool // drop_child_key columns
	flat     []string        // one-relations whose columns merge into this row's array form
	rels     map[string]bool // relations that were loaded (even when null/empty)
	cascade  []string        // loaded relations whose rows belong to this row (children[].cascade), in child order
}

// SetProjection records what the row's assemble node selected (generated scanners call it).
func (r *Row) SetProjection(a *plan.Assemble) {
	r.selected = r.selected[:0]
	for _, c := range a.Columns {
		r.selected = append(r.selected, c.Name)
		if c.Hidden {
			if r.hidden == nil {
				r.hidden = map[string]bool{}
			}
			r.hidden[c.Name] = true
		}
	}
	for _, ch := range a.Children {
		if r.rels == nil {
			r.rels = map[string]bool{}
		}
		r.rels[ch.Rel] = true
		if ch.Flatten {
			r.flat = append(r.flat, ch.Rel)
		}
		if ch.Cascade {
			r.cascade = append(r.cascade, ch.Rel)
		}
	}
}

// Selected lists the projected output names; Hidden/Flat/RelLoaded expose the assembly facts.
func (r *Row) Selected() []string      { return r.selected }
func (r *Row) Hidden(name string) bool { return r.hidden[name] }
func (r *Row) Flat() []string          { return r.flat }
func (r *Row) RelLoaded(rel string) bool { return r.rels[rel] }

// Cascades lists the loaded relations DeleteCascade removes before this row, in load order.
func (r *Row) Cascades() []string { return r.cascade }

// FormatTime renders a datetime the way every language's array form does.
func FormatTime(t time.Time) string { return t.Format("2006-01-02 15:04:05.000000") }

// MergeFlat copies a flattened child's array form into the parent's (parent keys win).
func MergeFlat(parent, child map[string]any) {
	for k, v := range child {
		if _, ok := parent[k]; !ok {
			parent[k] = v
		}
	}
}

// SetExtra records a computed or aliased output column (generated scanners call it).
func (r *Row) SetExtra(name string, v any) {
	if r.extra == nil {
		r.extra = map[string]any{}
	}
	r.extra[name] = v
}

// Extra returns a selectExpr / select<Col>As output by name (nil when absent).
func (r *Row) Extra(name string) any { return r.extra[name] }

func (r *Row) Loaded() bool { return r.loaded }

func (r *Row) Mark(entity, pk string, pkVal any) {
	r.entity, r.pk, r.pkVal, r.loaded = entity, pk, pkVal, true
}

func (r *Row) Dirty(col string, v any) {
	// last write wins for the same column
	for i, a := range r.dirty {
		if a.Column == col {
			r.dvals[i] = v
			return
		}
	}
	r.dirty = append(r.dirty, ir.Assign{Column: col})
	r.dvals = append(r.dvals, v)
}

// DirtyStyled records a styled column change with its encoded value; the
// encode error is kept and surfaces from UpdateRow.
func (r *Row) DirtyStyled(col string, v any, styles []string) {
	enc, err := Encode(styles, v)
	if err != nil {
		r.encErr = err
		return
	}
	r.Dirty(col, enc)
}

// UpdateRow writes the dirty columns; optimistic passes the loaded updated_ts value.
func (r *Row) UpdateRow(ctx context.Context, ex Exec, optimisticCol string, optimisticVal any) error {
	if r.encErr != nil {
		return r.encErr
	}
	if !r.loaded {
		return fmt.Errorf("orm: update on a row that was not loaded")
	}
	if len(r.dirty) == 0 {
		return nil
	}
	req := NewReq(ex.db().Eng, "update", r.entity)
	for i, a := range r.dirty {
		p := req.P(r.dvals[i])
		req.IR.Set = append(req.IR.Set, ir.Assign{Column: a.Column, P: &p})
	}
	pk := req.P(r.pkVal)
	req.IR.Where = &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: r.pk, Op: "eq", P: &pk}}}}
	if optimisticCol != "" {
		req.IR.Optimistic = &ir.Optimist{Column: optimisticCol, P: req.P(optimisticVal)}
	}
	if _, _, err := Write(ctx, ex, req); err != nil {
		return err
	}
	r.dirty, r.dvals = nil, nil
	return nil
}

func (r *Row) DeleteRow(ctx context.Context, ex Exec) error {
	if !r.loaded {
		return fmt.Errorf("orm: delete on a row that was not loaded")
	}
	req := NewReq(ex.db().Eng, "delete", r.entity)
	pk := req.P(r.pkVal)
	req.IR.Where = &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: r.pk, Op: "eq", P: &pk}}}}
	_, _, err := Write(ctx, ex, req)
	return err
}

// Slice returns the values of one assemble node from a positional row.
func Slice(vals []any, a *plan.Assemble) []any {
	if len(a.Columns) == 0 {
		return nil
	}
	start := a.Columns[0].Index
	return vals[start : start+len(a.Columns)]
}

// Index finds a column's position within an assemble node by output name.
func Index(a *plan.Assemble, name string) int {
	for i, c := range a.Columns {
		if c.Name == name {
			return i
		}
	}
	return -1
}
