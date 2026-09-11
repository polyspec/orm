// Package orm is the Go executor: it turns a Req (IR + params) into rows using
// database/sql, caching compiled plans by IR shape and prepared statements by
// SQL text. Generated code (clients/go/gen) builds Reqs and maps rows to
// typed structs; nothing here knows table names.
package orm

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	"github.com/maxkwon/orm/engine"
	"github.com/maxkwon/orm/engine/ir"
	"github.com/maxkwon/orm/engine/plan"
)

// Config is the executor configuration. Paths and secrets are declared, never discovered.
type Config struct {
	AESKey  string // secret "aes" for aes/aes_hex columns
	OnQuery func(Event)
}

// Event is emitted for every executed statement when Config.OnQuery is set.
type Event struct {
	SQL      string
	Args     []any
	Duration time.Duration
	Err      error
}

// DB wraps *sql.DB with the compiler, the plan cache and the statement cache.
type DB struct {
	SQL *sql.DB
	Eng *engine.Engine
	cfg Config

	plans sync.Map // uint64 shape hash -> *plan.Plan
	stmMu sync.Mutex
	stmts map[string]*sql.Stmt
}

// Open connects with database/sql. The DSN must enable clientFoundRows (needed
// for optimistic locking) — Open refuses DSNs without it rather than guessing.
func Open(driver, dsn string, eng *engine.Engine, cfg Config) (*DB, error) {
	if driver == "mysql" && !strings.Contains(dsn, "clientFoundRows=true") {
		return nil, errors.New("orm: mysql DSN must include clientFoundRows=true")
	}
	s, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	if err := s.Ping(); err != nil {
		return nil, err
	}
	return &DB{SQL: s, Eng: eng, cfg: cfg, stmts: map[string]*sql.Stmt{}}, nil
}

// Exec is what terminals take: a *DB or a *Tx.
type Exec interface {
	DB() *DB
	db() *DB
	stmt(ctx context.Context, sqlText string) (*sql.Stmt, error)
}

func (d *DB) db() *DB { return d }

func (d *DB) stmt(ctx context.Context, sqlText string) (*sql.Stmt, error) {
	d.stmMu.Lock()
	st, ok := d.stmts[sqlText]
	d.stmMu.Unlock()
	if ok {
		return st, nil
	}
	st, err := d.SQL.PrepareContext(ctx, sqlText)
	if err != nil {
		return nil, err
	}
	d.stmMu.Lock()
	if prev, ok := d.stmts[sqlText]; ok {
		d.stmMu.Unlock()
		st.Close()
		return prev, nil
	}
	d.stmts[sqlText] = st
	d.stmMu.Unlock()
	return st, nil
}

// Tx is a transaction handle; it reuses the DB's prepared statements.
type Tx struct {
	d  *DB
	tx *sql.Tx
}

func (t *Tx) db() *DB { return t.d }

func (t *Tx) stmt(ctx context.Context, sqlText string) (*sql.Stmt, error) {
	st, err := t.d.stmt(ctx, sqlText)
	if err != nil {
		return nil, err
	}
	return t.tx.StmtContext(ctx, st), nil
}

// Transaction runs fn in a transaction. An error or panic rolls back. On a
// deadlock the whole closure is re-run in a new transaction (compatibility
// behaviour), at most 3 attempts with 50ms·2^n + jitter between them.
func Transaction[T any](ctx context.Context, d *DB, fn func(*Tx) (T, error)) (T, error) {
	var zero T
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		v, err := runTx(ctx, d, fn)
		if err == nil {
			return v, nil
		}
		lastErr = err
		if !IsDeadlock(err) {
			return zero, err
		}
		delay := time.Duration(50<<attempt)*time.Millisecond + time.Duration(rand.IntN(20))*time.Millisecond
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return zero, ctx.Err()
		}
	}
	return zero, lastErr
}

func runTx[T any](ctx context.Context, d *DB, fn func(*Tx) (T, error)) (v T, err error) {
	tx, err := d.SQL.BeginTx(ctx, nil)
	if err != nil {
		return v, err
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
			panic(r)
		}
	}()
	v, err = fn(&Tx{d: d, tx: tx})
	if err != nil {
		tx.Rollback()
		return v, err
	}
	if err := tx.Commit(); err != nil {
		return v, err
	}
	return v, nil
}

// Err codes surfaced by the executor (engine codes pass through unchanged).
var (
	ErrOptimisticLock = &ir.Error{Code: "OPTIMISTIC_LOCK", Msg: "row changed since it was read"}
)

// IsDeadlock reports MySQL 1213 / SQLSTATE 40001 style errors (driver-agnostic by message).
func IsDeadlock(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "1213") || strings.Contains(s, "40001") || strings.Contains(strings.ToLower(s), "deadlock")
}

// Req is one statement under construction: the value-free IR plus the values.
type Req struct {
	IR     ir.Request
	Params []any
	Err    error // first deferred builder error (codec encode); surfaces from the terminal
}

// NewReq starts a request for an entity against the engine's schema.
func NewReq(eng *engine.Engine, kind, entity string) *Req {
	r := &Req{}
	r.IR.IRVersion = ir.Version
	r.IR.SchemaHash = eng.M.SchemaHash
	r.IR.Kind = kind
	r.IR.Entity = entity
	return r
}

// P registers a value and returns its parameter index.
func (r *Req) P(v any) int {
	r.Params = append(r.Params, v)
	return len(r.Params) - 1
}

// Attach merges a child query built with its own Req into this request:
// the child's params are appended and every index in its tree is shifted.
func (r *Req) Attach(child *Req) *ir.Query {
	off := len(r.Params)
	r.Params = append(r.Params, child.Params...)
	q := child.IR.Query
	shiftQuery(&q, off)
	return &q
}

func shiftQuery(q *ir.Query, off int) {
	shiftGroup(q.On, off)
	shiftGroup(q.Where, off)
	for _, j := range q.Joins {
		shiftQuery(j.Query, off)
	}
	for _, rl := range q.Relations {
		shiftQuery(rl.Query, off)
	}
	if q.IfParent != nil {
		q.IfParent.P += off
	}
}

func shiftGroup(g *ir.Group, off int) {
	if g == nil {
		return
	}
	for i := range g.Items {
		it := &g.Items[i]
		switch {
		case it.Pred != nil:
			if it.Pred.P != nil {
				v := *it.Pred.P + off
				it.Pred.P = &v
			}
			for k := range it.Pred.Ps {
				it.Pred.Ps[k] += off
			}
		case it.Group != nil:
			shiftGroup(it.Group, off)
		case it.Nav != nil:
			shiftGroup(it.Nav.Group, off)
		}
	}
}

// Plan compiles (or fetches from cache) the plan for the request's shape.
func (d *DB) Plan(r *Req) (*plan.Plan, error) {
	if r.Err != nil {
		return nil, r.Err
	}
	r.IR.NParams = len(r.Params)
	shape, err := json.Marshal(&r.IR)
	if err != nil {
		return nil, err
	}
	h := fnv.New64a()
	h.Write(shape)
	key := h.Sum64()
	if p, ok := d.plans.Load(key); ok {
		return p.(*plan.Plan), nil
	}
	if err := ir.Validate(d.Eng.M, &r.IR); err != nil {
		return nil, err
	}
	p, err := d.Eng.P.Compile(&r.IR)
	if err != nil {
		return nil, err
	}
	d.plans.Store(key, p)
	return p, nil
}

// args resolves a step's bind slots against the request's params.
func (d *DB) args(st *plan.Step, r *Req, parentVals []any) ([]any, error) {
	out := make([]any, 0, len(st.BindSlots))
	for _, b := range st.BindSlots {
		switch b.From {
		case "param":
			v := r.Params[b.Param]
			if b.Transform != "" {
				s, ok := v.(string)
				if !ok {
					return nil, fmt.Errorf("orm: transform %s needs a string param", b.Transform)
				}
				v = Transform(b.Transform, s)
			}
			out = append(out, v)
		case "secret":
			if b.Name != "aes" || d.cfg.AESKey == "" {
				return nil, fmt.Errorf("orm: secret %q not configured", b.Name)
			}
			out = append(out, d.cfg.AESKey)
		case "parent":
			out = append(out, parentVals...)
		default:
			return nil, fmt.Errorf("orm: bind from %q", b.From)
		}
	}
	return out, nil
}

// Transform applies an executor-side value transform (same in every language).
func Transform(kind, s string) string {
	switch kind {
	case "fulltext_boolean":
		s = strings.TrimSpace(s)
		if s == "" {
			return s
		}
		return "+" + strings.ReplaceAll(s, " ", " +") + "*"
	case "like_contains", "like_starts", "like_ends":
		esc := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
		switch kind {
		case "like_contains":
			return "%" + esc + "%"
		case "like_starts":
			return esc + "%"
		default:
			return "%" + esc
		}
	}
	return s
}

// Rows is the positional result of a select plan: the main step's rows plus
// every relation step's rows, grouped by their match column so generated
// scanners can attach them (Related).
type Rows struct {
	Assemble *plan.Assemble
	Data     [][]any
	steps    map[int]*stepRows
	params   []any
}

type stepRows struct {
	step  *plan.Step
	data  [][]any
	byKey map[Key][]int
}

// Related returns the rows of relation child ch that belong to one parent row
// (a positional row of the step ch hangs off). Empty when the parent's value
// is null, when the step was skipped, or when the parent fails IfParent.
func (r *Rows) Related(ch *plan.Child, parent []any) [][]any {
	sr := r.steps[ch.Step]
	if sr == nil {
		return nil
	}
	if ifp := sr.step.Parent.IfParent; ifp != nil && !SameScalar(parent[ifp.Index], r.params[ifp.Param]) {
		return nil
	}
	pv := parent[ch.ParentIndex]
	if pv == nil {
		return nil
	}
	idxs := sr.byKey[KeyOf(pv)]
	out := make([][]any, len(idxs))
	for i, j := range idxs {
		out[i] = sr.data[j]
	}
	return out
}

// StepAssemble is the assembly of the step a relation child's rows come from.
func (r *Rows) StepAssemble(ch *plan.Child) *plan.Assemble { return r.steps[ch.Step].step.Assemble }

// SameScalar compares a row value with a bound parameter regardless of the
// driver's or the caller's numeric/bool representation.
func SameScalar(a, b any) bool { return scalarKey(a) == scalarKey(b) }

func scalarKey(v any) string {
	switch x := v.(type) {
	case nil:
		return "\x00"
	case bool:
		if x {
			return "1"
		}
		return "0"
	case []byte:
		return string(x)
	case string:
		return x
	case time.Time:
		return x.UTC().Format("2006-01-02 15:04:05.000000")
	}
	return fmt.Sprint(v)
}

func (d *DB) emit(sqlText string, args []any, start time.Time, err error) {
	if d.cfg.OnQuery != nil {
		d.cfg.OnQuery(Event{SQL: sqlText, Args: args, Duration: time.Since(start), Err: err})
	}
}

// Query runs the main select step and every relation step of the plan and
// returns positional rows. Values come back as int64 / float64 / string /
// time.Time / bool / nil.
func Query(ctx context.Context, ex Exec, r *Req) (*Rows, error) {
	d := ex.db()
	p, err := d.Plan(r)
	if err != nil {
		return nil, err
	}
	return runPlan(ctx, ex, p, r)
}

func runPlan(ctx context.Context, ex Exec, p *plan.Plan, r *Req) (*Rows, error) {
	main, err := runSelect(ctx, ex, &p.Steps[0], r, nil)
	if err != nil {
		return nil, err
	}
	out := &Rows{Assemble: p.Steps[0].Assemble, Data: main, steps: map[int]*stepRows{}, params: r.Params}
	for i := range p.Steps[1:] {
		st := &p.Steps[i+1]
		if st.Role != "relation" {
			continue
		}
		parents := out.Data
		if st.Parent.Step != 0 {
			parents = out.steps[st.Parent.Step].data
		}
		sr := &stepRows{step: st, byKey: map[Key][]int{}}
		vals := parentValues(st.Parent, parents, r.Params)
		if len(vals) > 0 {
			if sr.data, err = runSelect(ctx, ex, st, r, vals); err != nil {
				return nil, err
			}
			ci := childIndex(p, st)
			for j, row := range sr.data {
				k := KeyOf(row[ci])
				sr.byKey[k] = append(sr.byKey[k], j)
			}
		}
		out.steps[st.ID] = sr
	}
	return out, nil
}

// childIndex finds the match column of a relation step from the child spec that references it.
func childIndex(p *plan.Plan, st *plan.Step) int {
	var find func(a *plan.Assemble) int
	find = func(a *plan.Assemble) int {
		for _, ch := range a.Children {
			if ch.Kind != "join" && ch.Step == st.ID {
				return ch.ChildIndex
			}
			if ch.Kind == "join" {
				if i := find(ch.Assemble); i >= 0 {
					return i
				}
			}
		}
		return -1
	}
	for i := range p.Steps {
		if p.Steps[i].Assemble != nil {
			if idx := find(p.Steps[i].Assemble); idx >= 0 {
				return idx
			}
		}
	}
	panic("orm: relation step without a child spec")
}

// parentValues collects the distinct non-null values a relation step binds,
// in first-seen order, from the parent rows that pass IfParent.
func parentValues(pr *plan.ParentRef, parents [][]any, params []any) []any {
	seen := map[Key]bool{}
	var out []any
	for _, row := range parents {
		if pr.IfParent != nil && !SameScalar(row[pr.IfParent.Index], params[pr.IfParent.Param]) {
			continue
		}
		v := row[pr.Index]
		if v == nil {
			continue
		}
		k := KeyOf(v)
		if !seen[k] {
			seen[k] = true
			out = append(out, v)
		}
	}
	return out
}

// expandIn rewrites the step's single `parent` placeholder into n placeholders.
// n is rounded up to a power of two (values are padded by repetition) so the
// prepared-statement cache holds one statement per size class, not per size.
func expandIn(st *plan.Step, vals []any) (string, []any) {
	n := 1
	for n < len(vals) {
		n <<= 1
	}
	padded := make([]any, n)
	copy(padded, vals)
	for i := len(vals); i < n; i++ {
		padded[i] = vals[len(vals)-1]
	}
	slot := 0
	var sb strings.Builder
	for i := 0; i < len(st.SQL); i++ {
		c := st.SQL[i]
		if c != '?' {
			sb.WriteByte(c)
			continue
		}
		if st.BindSlots[slot].From == "parent" {
			sb.WriteString("?" + strings.Repeat(", ?", n-1))
		} else {
			sb.WriteByte('?')
		}
		slot++
	}
	return sb.String(), padded
}

func runSelect(ctx context.Context, ex Exec, st *plan.Step, r *Req, parentVals []any) ([][]any, error) {
	d := ex.db()
	sqlText := st.SQL
	if parentVals != nil {
		sqlText, parentVals = expandIn(st, parentVals)
	}
	args, err := d.args(st, r, parentVals)
	if err != nil {
		return nil, err
	}
	stmt, err := ex.stmt(ctx, sqlText)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	rows, err := stmt.QueryContext(ctx, args...)
	d.emit(sqlText, args, start, err)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	n := countCols(st.Assemble)
	styled := styledCols(st.Assemble)
	var out [][]any
	for rows.Next() {
		vals := make([]any, n)
		ptrs := make([]any, n)
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		for i, v := range vals {
			if b, ok := v.([]byte); ok {
				vals[i] = string(b)
			}
		}
		for _, c := range styled {
			dv, err := Decode(c.Styles, vals[c.Index])
			if err != nil {
				return nil, fmt.Errorf("%s.%s: %w", st.Assemble.Entity, c.Name, err)
			}
			vals[c.Index] = dv
		}
		out = append(out, vals)
	}
	return out, rows.Err()
}

// countCols is the width of one positional row: the node's columns plus its joins'.
func countCols(a *plan.Assemble) int {
	n := len(a.Columns)
	for _, c := range a.Children {
		if c.Kind == "join" {
			n += countCols(c.Assemble)
		}
	}
	return n
}

// Scalar runs a count/sum/avg step.
func Scalar(ctx context.Context, ex Exec, r *Req) (any, error) {
	d := ex.db()
	p, err := d.Plan(r)
	if err != nil {
		return nil, err
	}
	st := &p.Steps[0]
	args, err := d.args(st, r, nil)
	if err != nil {
		return nil, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return nil, err
	}
	var v any
	start := time.Now()
	err = stmt.QueryRowContext(ctx, args...).Scan(&v)
	d.emit(st.SQL, args, start, err)
	if b, ok := v.([]byte); ok {
		v = string(b)
	}
	return v, err
}

// Paginate runs the main step (with its relations) and the count step.
func Paginate(ctx context.Context, ex Exec, r *Req) (*Rows, int64, error) {
	d := ex.db()
	p, err := d.Plan(r)
	if err != nil {
		return nil, 0, err
	}
	rows, err := runPlan(ctx, ex, p, r)
	if err != nil {
		return nil, 0, err
	}
	var st *plan.Step
	for i := range p.Steps {
		if p.Steps[i].Role == "count" {
			st = &p.Steps[i]
		}
	}
	args, err := d.args(st, r, nil)
	if err != nil {
		return nil, 0, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return nil, 0, err
	}
	var total int64
	start := time.Now()
	err = stmt.QueryRowContext(ctx, args...).Scan(&total)
	d.emit(st.SQL, args, start, err)
	return rows, total, err
}

// Write runs insert/update/delete. For insert it returns the new id; for
// update with optimistic locking it returns ErrOptimisticLock when no row matched.
func Write(ctx context.Context, ex Exec, r *Req) (lastID, affected int64, err error) {
	d := ex.db()
	p, err := d.Plan(r)
	if err != nil {
		return 0, 0, err
	}
	st := &p.Steps[0]
	args, err := d.args(st, r, nil)
	if err != nil {
		return 0, 0, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return 0, 0, err
	}
	start := time.Now()
	res, err := stmt.ExecContext(ctx, args...)
	d.emit(st.SQL, args, start, err)
	if err != nil {
		return 0, 0, err
	}
	affected, _ = res.RowsAffected()
	if r.IR.Kind == "insert" {
		lastID, _ = res.LastInsertId()
	}
	if r.IR.Kind == "update" && r.IR.Optimistic != nil && affected == 0 {
		return 0, 0, ErrOptimisticLock
	}
	return lastID, affected, nil
}

// Key is a collection key: an int64 or a string, whichever the key column yields.
type Key struct {
	I     int64
	S     string
	isStr bool
}

func KeyOf(v any) Key {
	switch x := v.(type) {
	case int64:
		return Key{I: x}
	case int:
		return Key{I: int64(x)}
	case int32:
		return Key{I: int64(x)}
	case uint64:
		return Key{I: int64(x)}
	case uint32:
		return Key{I: int64(x)}
	case string:
		return Key{S: x, isStr: true}
	case []byte:
		return Key{S: string(x), isStr: true}
	}
	return Key{S: fmt.Sprint(v), isStr: true}
}

func (k Key) String() string {
	if k.isStr {
		return k.S
	}
	return fmt.Sprint(k.I)
}

// Collection is an ordered map keyed by PK (or key_by). Never nil from a terminal.
type Collection[T any] struct {
	keys  []Key
	items map[Key]*T
}

func NewCollection[T any](n int) *Collection[T] {
	return &Collection[T]{keys: make([]Key, 0, n), items: make(map[Key]*T, n)}
}

func (c *Collection[T]) Put(k Key, v *T) {
	if _, ok := c.items[k]; !ok {
		c.keys = append(c.keys, k)
	}
	c.items[k] = v
}

func (c *Collection[T]) Get(k Key) *T { return c.items[k] }
func (c *Collection[T]) Len() int     { return len(c.keys) }

func (c *Collection[T]) First() *T {
	if len(c.keys) == 0 {
		return nil
	}
	return c.items[c.keys[0]]
}

// All iterates in insertion order: for k, v := range c.All().
func (c *Collection[T]) All() func(yield func(Key, *T) bool) {
	return func(yield func(Key, *T) bool) {
		for _, k := range c.keys {
			if !yield(k, c.items[k]) {
				return
			}
		}
	}
}

func (c *Collection[T]) ToSlice() []*T {
	out := make([]*T, 0, len(c.keys))
	for _, k := range c.keys {
		out = append(out, c.items[k])
	}
	return out
}

// Page is the result of paginate.
type Page[T any] struct {
	Items   *Collection[T]
	Total   int64
	Pages   int64
	Current int64
	Per     int64
}

// ---- value coercion used by generated scanners ----

func AsInt64(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int32:
		return int64(x)
	case int:
		return int64(x)
	case uint64:
		return int64(x)
	case float64:
		return int64(x)
	case string:
		var n int64
		fmt.Sscan(x, &n)
		return n
	}
	return 0
}

func AsFloat64(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int64:
		return float64(x)
	case string:
		var f float64
		fmt.Sscan(x, &f)
		return f
	}
	return 0
}

func AsString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	case nil:
		return ""
	case time.Time:
		return x.Format("2006-01-02 15:04:05.000000")
	}
	return fmt.Sprint(v)
}

func AsBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case int64:
		return x != 0
	case string:
		return x == "1" || x == "true"
	}
	return false
}

func AsTime(v any) time.Time {
	switch x := v.(type) {
	case time.Time:
		return x
	case string:
		for _, layout := range []string{"2006-01-02 15:04:05.999999", "2006-01-02 15:04:05", "2006-01-02"} {
			if t, err := time.Parse(layout, x); err == nil {
				return t
			}
		}
	}
	return time.Time{}
}

// Anys converts a typed slice for PredList.
func Anys[T any](vs []T) []any {
	out := make([]any, len(vs))
	for i, v := range vs {
		out[i] = v
	}
	return out
}

// Deref unwraps a pointer for Dirty (nil stays nil).
func Deref[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

// JoinPresent reports whether a LEFT JOIN child matched (its PK is non-nil).
func JoinPresent(vals []any, a *plan.Assemble) bool {
	if len(a.Columns) == 0 {
		return false
	}
	return vals[a.Columns[0].Index] != nil
}

// DB exposes the connection for generated terminals that need a follow-up query.
func (d *DB) DB() *DB { return d }

// Cfg is the live configuration (hooks may be swapped at runtime, e.g. by tests).
func (d *DB) Cfg() *Config { return &d.cfg }
func (t *Tx) DB() *DB { return t.d }
