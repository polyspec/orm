// Package orm is the Go executor: it turns a Req (IR + params) into rows using
// database/sql, caching compiled plans by IR shape and prepared statements by
// SQL text. Generated code (clients/go/gen) builds Reqs and maps rows to
// typed structs; nothing here knows table names.
package orm

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math/rand/v2"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
)

// Config is the executor configuration. Paths and secrets are declared, never discovered.
type Config struct {
	AESKey  string // secret "aes" for aes/aes_hex columns
	OnQuery func(Event)
}

// Event is emitted for every executed statement when Config.OnQuery is set.
// The same payload in every language: (sql, binds, duration, plan_id, err).
type Event struct {
	SQL      string
	Args     []any // the binds, with every secret slot rendered as Secret ("$SECRET")
	Duration time.Duration
	PlanID   string // plan cache key (FNV-1a 64 of the IR shape) as 16 hex digits: group logs by statement shape
	Err      error
}

// Secret replaces a secret bind (the AES key) wherever binds are shown.
const Secret = "$SECRET"

// Now replaces executor-supplied timestamps (`now` slots) in hook payloads.
const Now = "$NOW"

// DB wraps *sql.DB with the compiler, the plan cache and the statement cache.
type DB struct {
	SQL    *sql.DB
	Eng    *engine.Engine
	cfg    Config
	driver string

	planMu sync.RWMutex
	plans  map[uint64]*cached // shape key -> compiled plan plus the per-step facts derived from it
	stmMu  sync.Mutex
	stmts  map[string]*sql.Stmt
}

// Open connects with database/sql. The DSN must enable clientFoundRows (needed
// for optimistic locking) — Open refuses DSNs without it rather than guessing.
// Open connects with database/sql. driver is mysql | postgres | sqlite and must
// be the dialect the engine compiles for (docs/dialects.md): the plans are
// dialect-specific text.
func Open(driver, dsn string, eng *engine.Engine, cfg Config) (*DB, error) {
	sqlDriver, ok := lookupDriver(driver)
	if !ok {
		msg := fmt.Sprintf("driver %q is not registered", driver)
		if driver == "postgres" || driver == "sqlite" {
			msg += fmt.Sprintf(`: import _ "github.com/polyspec/orm/clients/go/orm/%s"`, driver)
		}
		return nil, &ir.Error{Code: CodeConfig, Msg: msg}
	}
	if eng.P.D.Name() != driver {
		return nil, &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf("driver %s but the engine compiles for %s", driver, eng.P.D.Name())}
	}
	if driver == "mysql" && !strings.Contains(dsn, "clientFoundRows=true") {
		return nil, &ir.Error{Code: CodeConfig, Msg: "mysql DSN must include clientFoundRows=true"}
	}
	s, err := sql.Open(sqlDriver, dsn)
	if err != nil {
		return nil, &ir.Error{Code: CodeConfig, Msg: err.Error()}
	}
	if err := s.Ping(); err != nil {
		return nil, mapDriverErr(err)
	}
	return &DB{SQL: s, Eng: eng, cfg: cfg, driver: driver, plans: map[uint64]*cached{}, stmts: map[string]*sql.Stmt{}}, nil
}

// Drivers beyond MySQL live in their own packages so a MySQL-only program does
// not link PostgreSQL and SQLite (together ~8MB and a package init that parses
// /etc/services): import github.com/polyspec/orm/clients/go/orm/pg or .../sqlite
// for its side effect, exactly as database/sql drivers are imported.
var (
	driverMu   sync.RWMutex
	sqlDrivers = map[string]string{"mysql": "mysql"}
	errMappers = map[string]func(error) error{"mysql": mapMySQLErr}
)

// RegisterDriver teaches Open a driver name, the database/sql driver behind it,
// and how to turn that driver's errors into the codes docs/errors.yaml names.
// The driver packages call it from init().
func RegisterDriver(name, sqlDriver string, mapErr func(error) error) {
	driverMu.Lock()
	defer driverMu.Unlock()
	sqlDrivers[name] = sqlDriver
	errMappers[name] = mapErr
}

func lookupDriver(name string) (string, bool) {
	driverMu.RLock()
	defer driverMu.RUnlock()
	d, ok := sqlDrivers[name]
	return d, ok
}

// Driver is the database this DB talks to (mysql | postgres | sqlite).
func (d *DB) Driver() string { return d.driver }

// CheckSchemaHash compares the hash the generated package was produced from
// with the manifest the engine loaded. Generated Init calls it exactly once at
// startup; there is no watching and no reload — regenerate and restart.
func CheckSchemaHash(eng *engine.Engine, generated string) error {
	if eng.M.SchemaHash != generated {
		return &ir.Error{Code: CodeSchemaHashMismatch, Msg: fmt.Sprintf("generated client is from schema %s, the engine loaded %s: run ormgen gen again", generated, eng.M.SchemaHash)}
	}
	return nil
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
		return nil, mapDriverErr(err)
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
		return v, mapDriverErr(err)
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
		return v, mapDriverErr(err)
	}
	return v, nil
}

// Err codes surfaced by the executor (engine codes pass through unchanged).
var (
	ErrOptimisticLock = &ir.Error{Code: CodeOptimisticLock, Msg: "row changed since it was read"}
)

// mapDriverErr turns the driver errors the catalog names (docs/errors.yaml,
// origin driver) into *ir.Error: MySQL 1213 / SQLSTATE 40001 → DEADLOCK,
// 1062 → DUPLICATE_KEY (SQLSTATE 23000 only when the driver gives no number:
// 23000 also covers foreign-key and not-null violations). The driver's own
// message is kept as Msg. Every other error passes through unchanged.
func mapDriverErr(err error) error {
	if err == nil {
		return nil
	}
	driverMu.RLock()
	mappers := errMappers
	driverMu.RUnlock()
	for _, m := range mappers {
		if mapped := m(err); mapped != err {
			return mapped
		}
	}
	return err
}

func mapMySQLErr(err error) error {
	var me *mysql.MySQLError
	if !errors.As(err, &me) {
		return err
	}
	state := string(me.SQLState[:])
	switch {
	case me.Number == 1213 || state == "40001":
		return &ir.Error{Code: CodeDeadlock, Msg: me.Error()}
	case me.Number == 1062 || (me.Number == 0 && state == "23000"):
		return &ir.Error{Code: CodeDuplicateKey, Msg: me.Error()}
	}
	return err
}

// IsDeadlock reports a DEADLOCK error: the mapped code, or for errors that did
// not pass through the executor (a foreign driver), the message.
func IsDeadlock(err error) bool {
	if err == nil {
		return false
	}
	var e *ir.Error
	if errors.As(err, &e) {
		return e.Code == CodeDeadlock
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

// cached is one plan-cache entry: the compiled plan and the facts every
// execution needs from it, derived once here instead of per statement or per row.
type cached struct {
	key   uint64
	id    string // PlanID(key)
	plan  *plan.Plan
	scans map[*plan.Step]*scanInfo
	projs map[*plan.Assemble]*Projection
}

// scanInfo is what runSelect needs to read one step's rows.
type scanInfo struct {
	n      int           // width of a positional row (the node's columns plus its joins')
	styled []plan.OutCol // columns with executor-side codec stages
}

func newCached(key uint64, p *plan.Plan) *cached {
	c := &cached{key: key, id: PlanID(key), plan: p, scans: map[*plan.Step]*scanInfo{}, projs: map[*plan.Assemble]*Projection{}}
	var walk func(a *plan.Assemble)
	walk = func(a *plan.Assemble) {
		c.projs[a] = NewProjection(a)
		for _, ch := range a.Children {
			if ch.Kind == "join" {
				walk(ch.Assemble)
			}
		}
	}
	for i := range p.Steps {
		st := &p.Steps[i]
		if st.Assemble == nil {
			continue
		}
		c.scans[st] = &scanInfo{n: countCols(st.Assemble), styled: styledCols(st.Assemble)}
		walk(st.Assemble)
	}
	return c
}

// Plan compiles (or fetches from cache) the plan for the request's shape.
func (d *DB) Plan(r *Req) (*plan.Plan, error) {
	c, err := d.plan(r)
	if err != nil {
		return nil, err
	}
	return c.plan, nil
}

func (d *DB) plan(r *Req) (*cached, error) {
	if r.Err != nil {
		return nil, r.Err
	}
	r.IR.NParams = len(r.Params)
	key := shapeKey(&r.IR)
	d.planMu.RLock()
	c, ok := d.plans[key]
	d.planMu.RUnlock()
	if ok {
		return c, nil
	}
	if err := ir.Validate(d.Eng.M, &r.IR); err != nil {
		return nil, err
	}
	p, err := d.Eng.P.Compile(&r.IR)
	if err != nil {
		return nil, err
	}
	c = newCached(key, p)
	d.planMu.Lock()
	if prev, ok := d.plans[key]; ok {
		c = prev
	} else {
		d.plans[key] = c
	}
	d.planMu.Unlock()
	return c, nil
}

// args resolves a step's bind slots against the request's params. secrets
// lists the positions that hold a secret (nil when there is none) so the
// on_query hook can mask exactly those.
func (d *DB) args(st *plan.Step, r *Req, parentVals []any) (out []any, masks map[int]string, err error) {
	out = make([]any, 0, len(st.BindSlots))
	for _, b := range st.BindSlots {
		switch b.From {
		case "param":
			v, err := paramValue(&b, r)
			if err != nil {
				return nil, nil, err
			}
			if len(b.HostStyles) > 0 {
				if v, err = HostEncode(v, b.HostStyles, d.cfg.AESKey); err != nil {
					return nil, nil, err
				}
			}
			out = append(out, v)
		case "secret":
			if b.Name != "aes" || d.cfg.AESKey == "" {
				return nil, nil, &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf("secret %q not configured", b.Name)}
			}
			if masks == nil {
				masks = map[int]string{}
			}
			masks[len(out)] = Secret
			out = append(out, d.cfg.AESKey)
		case "parent":
			out = append(out, parentVals...)
		case "now":
			// dialects without a microsecond clock function (SQLite) get the timestamp from the executor;
			// hooks see "$NOW" so logs and recorded vectors stay deterministic
			if masks == nil {
				masks = map[int]string{}
			}
			masks[len(out)] = Now
			out = append(out, time.Now().UTC().Format("2006-01-02 15:04:05.000000"))
		default:
			return nil, nil, &ir.Error{Code: CodeInternal, Msg: fmt.Sprintf("bind from %q", b.From)}
		}
	}
	if d.driver == "sqlite" {
		// SQLite stores what it is given: keep datetimes in the canonical text form every reader parses
		for i, v := range out {
			if t, ok := v.(time.Time); ok {
				out[i] = t.UTC().Format("2006-01-02 15:04:05.000000")
			}
		}
	}
	return out, masks, nil
}

// paramValue is a param slot's bound value: the request's param after the slot's transform.
func paramValue(b *plan.BindSlot, r *Req) (any, error) {
	v := r.Params[b.Param]
	if b.Transform == "" {
		return v, nil
	}
	s, ok := v.(string)
	if !ok {
		return nil, fmt.Errorf("orm: transform %s needs a string param", b.Transform)
	}
	return Transform(b.Transform, s), nil
}

// Statement is what SQL() returns: the main step's text and its binds, secret
// slots rendered as "$SECRET" so the dump never carries a key.
type Statement struct {
	SQL   string
	Binds []any
}

// SQL compiles (and caches) the request's plan and renders its main step
// without executing anything.
func SQL(ctx context.Context, ex Exec, r *Req) (*Statement, error) {
	p, err := ex.db().Plan(r)
	if err != nil {
		return nil, err
	}
	st := &p.Steps[0]
	out := &Statement{SQL: st.SQL, Binds: make([]any, 0, len(st.BindSlots))}
	for _, b := range st.BindSlots {
		switch b.From {
		case "param":
			v, err := paramValue(&b, r)
			if err != nil {
				return nil, err
			}
			out.Binds = append(out.Binds, v)
		case "secret":
			out.Binds = append(out.Binds, Secret)
		case "now":
			out.Binds = append(out.Binds, Now)
		default:
			return nil, &ir.Error{Code: CodeInternal, Msg: fmt.Sprintf("bind from %q in a main step", b.From)}
		}
	}
	return out, nil
}

// InTx runs fn inside a transaction when ex is a bare DB, so a multi-statement
// walk (deleteCascade) never half-persists; inside a Tx it joins the caller's.
func InTx(ctx context.Context, ex Exec, fn func(Exec) error) error {
	d, ok := ex.(*DB)
	if !ok {
		return fn(ex)
	}
	_, err := Transaction(ctx, d, func(tx *Tx) (struct{}, error) { return struct{}{}, fn(tx) })
	return err
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
	c        *cached
	steps    map[int]*stepRows
	params   []any
}

// Projection is the assembly facts of one node, shared by every row scanned
// from it (generated scanners pass it to Row.SetProjection).
func (r *Rows) Projection(a *plan.Assemble) *Projection {
	p := r.c.projs[a]
	if p == nil {
		panic("orm: assemble node outside the plan")
	}
	return p
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

// emit delivers one executed statement to the on_query hook. Secret binds are
// masked in a copy; the args the driver saw are never handed out.
func (d *DB) emit(c *cached, sqlText string, args []any, masks map[int]string, start time.Time, err error) {
	if d.cfg.OnQuery == nil {
		return
	}
	if len(masks) > 0 {
		masked := make([]any, len(args))
		copy(masked, args)
		for i, m := range masks {
			masked[i] = m
		}
		args = masked
	}
	d.cfg.OnQuery(Event{SQL: sqlText, Args: args, Duration: time.Since(start), PlanID: c.id, Err: err})
}

// Query runs the main select step and every relation step of the plan and
// returns positional rows. Values come back as int64 / float64 / string /
// time.Time / bool / nil.
func Query(ctx context.Context, ex Exec, r *Req) (*Rows, error) {
	d := ex.db()
	c, err := d.plan(r)
	if err != nil {
		return nil, err
	}
	return runPlan(ctx, ex, c, r)
}

func runPlan(ctx context.Context, ex Exec, c *cached, r *Req) (*Rows, error) {
	p := c.plan
	main, err := runSelect(ctx, ex, c, &p.Steps[0], r, nil)
	if err != nil {
		return nil, err
	}
	out := &Rows{Assemble: p.Steps[0].Assemble, Data: main, c: c, params: r.Params}
	for i := range p.Steps[1:] {
		st := &p.Steps[i+1]
		if st.Role != "relation" {
			continue
		}
		if out.steps == nil {
			out.steps = map[int]*stepRows{}
		}
		parents := out.Data
		if st.Parent.Step != 0 {
			parents = out.steps[st.Parent.Step].data
		}
		sr := &stepRows{step: st, byKey: map[Key][]int{}}
		vals := parentValues(st.Parent, parents, r.Params)
		if len(vals) > 0 {
			if sr.data, err = runSelect(ctx, ex, c, st, r, vals); err != nil {
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
	var sb strings.Builder
	if strings.Contains(st.SQL, "$1") {
		// PostgreSQL: one $k per slot in slot order; the parent slot becomes n
		// placeholders and every later number shifts by n-1.
		parent := -1
		for i, b := range st.BindSlots {
			if b.From == "parent" {
				parent = i + 1
			}
		}
		for i := 0; i < len(st.SQL); i++ {
			c := st.SQL[i]
			if c != '$' {
				sb.WriteByte(c)
				continue
			}
			j := i + 1
			for j < len(st.SQL) && st.SQL[j] >= '0' && st.SQL[j] <= '9' {
				j++
			}
			k, _ := strconv.Atoi(st.SQL[i+1 : j])
			switch {
			case k == parent:
				for m := 0; m < n; m++ {
					if m > 0 {
						sb.WriteString(", ")
					}
					sb.WriteString("$" + strconv.Itoa(k+m))
				}
			case k > parent:
				sb.WriteString("$" + strconv.Itoa(k+n-1))
			default:
				sb.WriteString("$" + strconv.Itoa(k))
			}
			i = j - 1
		}
		return sb.String(), padded
	}
	slot := 0
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

// cell receives one column from database/sql. Scanning into *any makes the
// driver's []byte cloned once by database/sql and once more by the string
// conversion; a Scanner gets the driver's buffer itself and copies it exactly
// once. Every other driver value (int64, float64, bool, time.Time, nil) is
// kept as it is.
type cell struct{ v any }

func (c *cell) Scan(src any) error {
	if b, ok := src.([]byte); ok {
		c.v = string(b)
		return nil
	}
	c.v = src
	return nil
}

func runSelect(ctx context.Context, ex Exec, c *cached, st *plan.Step, r *Req, parentVals []any) ([][]any, error) {
	d := ex.db()
	sqlText := st.SQL
	if parentVals != nil {
		sqlText, parentVals = expandIn(st, parentVals)
	}
	args, masks, err := d.args(st, r, parentVals)
	if err != nil {
		return nil, err
	}
	stmt, err := ex.stmt(ctx, sqlText)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	rows, err := stmt.QueryContext(ctx, args...)
	err = mapDriverErr(err)
	d.emit(c, sqlText, args, masks, start, err)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	si := c.scans[st]
	n := si.n
	// One set of scan targets for the whole result; each row's values are
	// copied out into a slice carved from a block that grows with the result.
	cells := make([]cell, n)
	ptrs := make([]any, n)
	for i := range cells {
		ptrs[i] = &cells[i]
	}
	var block []any
	chunk := 4
	var out [][]any
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return nil, mapDriverErr(err)
		}
		if len(block) < n {
			block = make([]any, n*chunk)
			if chunk < 64 {
				chunk *= 2
			}
		}
		vals := block[:n:n]
		block = block[n:]
		for i := range cells {
			vals[i] = cells[i].v
		}
		for _, sc := range si.styled {
			codec, host := splitHost(sc.Styles)
			v := vals[sc.Index]
			var err error
			if len(host) > 0 {
				if v, err = hostDecode(v, host, d.cfg.AESKey); err != nil {
					return nil, fmt.Errorf("%s.%s: %w", st.Assemble.Entity, sc.Name, err)
				}
			}
			if len(codec) > 0 {
				if v, err = Decode(codec, v); err != nil {
					return nil, fmt.Errorf("%s.%s: %w", st.Assemble.Entity, sc.Name, err)
				}
			}
			vals[sc.Index] = v
		}
		out = append(out, vals)
	}
	return out, mapDriverErr(rows.Err())
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

// Scalar runs a count/count_distinct/sum/avg/min/max step (nil when the aggregate is NULL).
func Scalar(ctx context.Context, ex Exec, r *Req) (any, error) {
	d := ex.db()
	c, err := d.plan(r)
	if err != nil {
		return nil, err
	}
	st := &c.plan.Steps[0]
	args, masks, err := d.args(st, r, nil)
	if err != nil {
		return nil, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return nil, err
	}
	var v cell
	start := time.Now()
	err = mapDriverErr(stmt.QueryRowContext(ctx, args...).Scan(&v))
	d.emit(c, st.SQL, args, masks, start, err)
	return v.v, err
}

// RawAll runs a kind-raw request and returns its rows keyed by the driver's
// column names, values as the driver gives them ([]byte → string, no codec).
func RawAll(ctx context.Context, ex Exec, r *Req) ([]map[string]any, error) {
	d := ex.db()
	c, err := d.plan(r)
	if err != nil {
		return nil, err
	}
	st := &c.plan.Steps[0]
	args, masks, err := d.args(st, r, nil)
	if err != nil {
		return nil, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	rows, err := stmt.QueryContext(ctx, args...)
	err = mapDriverErr(err)
	d.emit(c, st.SQL, args, masks, start, err)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return nil, mapDriverErr(err)
	}
	cells := make([]cell, len(names))
	ptrs := make([]any, len(names))
	for i := range cells {
		ptrs[i] = &cells[i]
	}
	out := []map[string]any{}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return nil, mapDriverErr(err)
		}
		m := make(map[string]any, len(names))
		for i := range cells {
			m[names[i]] = cells[i].v
		}
		out = append(out, m)
	}
	return out, mapDriverErr(rows.Err())
}

// Paginate runs the main step (with its relations) and the count step.
func Paginate(ctx context.Context, ex Exec, r *Req) (*Rows, int64, error) {
	d := ex.db()
	c, err := d.plan(r)
	if err != nil {
		return nil, 0, err
	}
	p := c.plan
	rows, err := runPlan(ctx, ex, c, r)
	if err != nil {
		return nil, 0, err
	}
	var st *plan.Step
	for i := range p.Steps {
		if p.Steps[i].Role == "count" {
			st = &p.Steps[i]
		}
	}
	args, masks, err := d.args(st, r, nil)
	if err != nil {
		return nil, 0, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return nil, 0, err
	}
	var total int64
	start := time.Now()
	err = mapDriverErr(stmt.QueryRowContext(ctx, args...).Scan(&total))
	d.emit(c, st.SQL, args, masks, start, err)
	return rows, total, err
}

// Write runs insert/update/delete. For insert it returns the new id; for
// update with optimistic locking it returns ErrOptimisticLock when no row matched.
func Write(ctx context.Context, ex Exec, r *Req) (lastID, affected int64, err error) {
	d := ex.db()
	c, err := d.plan(r)
	if err != nil {
		return 0, 0, err
	}
	st := &c.plan.Steps[0]
	args, masks, err := d.args(st, r, nil)
	if err != nil {
		return 0, 0, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return 0, 0, err
	}
	start := time.Now()
	if r.IR.Kind == "insert" && strings.Contains(st.SQL, " RETURNING ") {
		// PostgreSQL/SQLite: the id comes back as a row, not from the driver's last insert id.
		err = mapDriverErr(stmt.QueryRowContext(ctx, args...).Scan(&lastID))
		d.emit(c, st.SQL, args, masks, start, err)
		if err != nil {
			return 0, 0, err
		}
		return lastID, 1, nil
	}
	res, err := stmt.ExecContext(ctx, args...)
	err = mapDriverErr(err)
	d.emit(c, st.SQL, args, masks, start, err)
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
		for _, layout := range []string{"2006-01-02 15:04:05.999999", "2006-01-02 15:04:05", "2006-01-02 15:04:05.999999-07:00", "2006-01-02 15:04:05-07:00", time.RFC3339Nano, "2006-01-02"} {
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
func (t *Tx) DB() *DB      { return t.d }
