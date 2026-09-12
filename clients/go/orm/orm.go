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
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
)

// Config is the executor configuration. Paths and secrets are declared, never discovered.
type Config struct {
	AESKey             string           // secret "aes" for aes/aes_hex columns
	BlindIndexKey      string           // stable secret "blind_index" for encrypted equality indexes
	AESVersion         int32            // secret "aes_version" written with AES payloads; zero selects version 1
	AESKeys            map[int32]string // all declared versions used to decode mixed-version rows
	PlanCacheSize      int              // maximum number of compiled plans; zero uses the default
	StatementCacheSize int              // maximum number of prepared statements; zero uses the default
	OnQuery            func(Event)
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
	SQL      *sql.DB
	Eng      *engine.Engine
	compiler planCompiler
	cfg      Config
	driver   string

	planMu    sync.RWMutex
	plans     map[uint64]*cached // shape key -> compiled plan plus the per-step facts derived from it
	planOrder []uint64
	stmMu     sync.Mutex
	stmts     map[string]*sql.Stmt
	stmtOrder []string
	closeOnce sync.Once
	closeErr  error
}

const defaultCacheSize = 256

// Open connects with database/sql. The DSN must enable clientFoundRows (needed
// for optimistic locking) — Open refuses DSNs without it rather than guessing.
// Open connects with database/sql. driver is mysql | postgres | sqlite and must
// be the dialect the engine compiles for (docs/dialects.md): the plans are
// dialect-specific text.
func Open(driver, dsn string, eng *engine.Engine, cfg Config) (*DB, error) {
	return open(context.Background(), driver, dsn, eng, enginePlanCompiler{engine: eng}, cfg)
}

// OpenWithCompiler connects with database/sql and uses compiler for every plan
// cache miss. Metadata must match the generated schema and database dialect.
func OpenWithCompiler(ctx context.Context, driver, dsn string, eng *engine.Engine, compiler CompilerTransport, cfg Config) (*DB, error) {
	if compiler == nil {
		return nil, &ir.Error{Code: CodeConfig, Msg: "compiler transport is required"}
	}
	return open(ctx, driver, dsn, eng, transportPlanCompiler{transport: compiler}, cfg)
}

func open(ctx context.Context, driver, dsn string, eng *engine.Engine, compiler planCompiler, cfg Config) (*DB, error) {
	if cfg.PlanCacheSize == 0 {
		cfg.PlanCacheSize = defaultCacheSize
	}
	if cfg.StatementCacheSize == 0 {
		cfg.StatementCacheSize = defaultCacheSize
	}
	if cfg.PlanCacheSize < 1 {
		return nil, &ir.Error{Code: CodeConfig, Msg: "plan cache size must be positive"}
	}
	if cfg.StatementCacheSize < 1 {
		return nil, &ir.Error{Code: CodeConfig, Msg: "statement cache size must be positive"}
	}
	sqlDriver, ok := lookupDriver(driver)
	if !ok {
		msg := fmt.Sprintf("driver %q is not registered", driver)
		if driver == "postgres" || driver == "sqlite" {
			msg += fmt.Sprintf(`: import _ "github.com/polyspec/orm/clients/go/orm/%s"`, driver)
		}
		return nil, &ir.Error{Code: CodeConfig, Msg: msg}
	}
	metadata, err := compiler.Metadata(ctx)
	if err != nil {
		return nil, err
	}
	if metadata.SchemaHash != eng.M.SchemaHash {
		return nil, &ir.Error{Code: CodeSchemaHashMismatch, Msg: fmt.Sprintf("client schema %s but compiler loaded %s", eng.M.SchemaHash, metadata.SchemaHash)}
	}
	if metadata.Dialect != driver {
		return nil, &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf("driver %s but the compiler uses %s", driver, metadata.Dialect)}
	}
	if metadata.IrVersion != ir.Version {
		return nil, &ir.Error{Code: CodeVersionMismatch, Msg: fmt.Sprintf("client IR version %d but compiler uses %d", ir.Version, metadata.IrVersion)}
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
	if cfg.AESVersion == 0 {
		cfg.AESVersion = 1
	}
	if len(cfg.AESKeys) == 0 && cfg.AESKey != "" {
		cfg.AESKeys = map[int32]string{cfg.AESVersion: cfg.AESKey}
	}
	return &DB{SQL: s, Eng: eng, compiler: compiler, cfg: cfg, driver: driver, plans: map[uint64]*cached{}, stmts: map[string]*sql.Stmt{}}, nil
}

// Close releases cached statements and the underlying database connection.
// It is idempotent and returns the first close error, if any.
func (d *DB) Close() error {
	d.closeOnce.Do(func() {
		d.planMu.Lock()
		d.plans = map[uint64]*cached{}
		d.planOrder = nil
		d.planMu.Unlock()
		d.stmMu.Lock()
		for key, st := range d.stmts {
			if err := st.Close(); err != nil && d.closeErr == nil {
				d.closeErr = fmt.Errorf("close statement %q: %w", key, err)
			}
		}
		d.stmts = map[string]*sql.Stmt{}
		d.stmtOrder = nil
		d.stmMu.Unlock()
		if err := d.SQL.Close(); err != nil && d.closeErr == nil {
			d.closeErr = err
		}
	})
	return d.closeErr
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

// Exec is the handle bound to a query: a *DB or a *Tx.
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
	d.stmtOrder = append(d.stmtOrder, sqlText)
	for len(d.stmtOrder) > d.cfg.StatementCacheSize {
		oldest := d.stmtOrder[0]
		d.stmtOrder = d.stmtOrder[1:]
		if old, exists := d.stmts[oldest]; exists {
			delete(d.stmts, oldest)
			_ = old.Close()
		}
	}
	d.stmMu.Unlock()
	return st, nil
}

// Tx is a transaction handle; it reuses the DB's prepared statements.
type Tx struct {
	d        *DB
	tx       *sql.Tx
	finished atomic.Bool
}

func (t *Tx) db() *DB { return t.d }

func (t *Tx) stmt(ctx context.Context, sqlText string) (*sql.Stmt, error) {
	if t.finished.Load() {
		return nil, &ir.Error{Code: CodeConfig, Msg: "transaction already finished"}
	}
	st, err := t.d.stmt(ctx, sqlText)
	if err != nil {
		return nil, err
	}
	return t.tx.StmtContext(ctx, st), nil
}

// Savepoint creates a named savepoint in the current transaction.
func (t *Tx) Savepoint(ctx context.Context, name string) error {
	return t.control(ctx, "SAVEPOINT", name)
}

// RollbackTo rolls the current transaction back to a named savepoint.
func (t *Tx) RollbackTo(ctx context.Context, name string) error {
	return t.control(ctx, "ROLLBACK TO SAVEPOINT", name)
}

// ReleaseSavepoint releases a named savepoint without ending the transaction.
func (t *Tx) ReleaseSavepoint(ctx context.Context, name string) error {
	return t.control(ctx, "RELEASE SAVEPOINT", name)
}

func (t *Tx) control(ctx context.Context, command, name string) error {
	if t.finished.Load() {
		return &ir.Error{Code: CodeConfig, Msg: "transaction already finished"}
	}
	if !validSavepointName(name) {
		return &ir.Error{Code: CodeConfig, Msg: "savepoint name must match [A-Za-z_][A-Za-z0-9_]*"}
	}
	if _, err := t.tx.ExecContext(ctx, command+" "+name); err != nil {
		return mapDriverErr(err)
	}
	return nil
}

func validSavepointName(name string) bool {
	if name == "" || !(name[0] == '_' || name[0] >= 'A' && name[0] <= 'Z' || name[0] >= 'a' && name[0] <= 'z') {
		return false
	}
	for i := 1; i < len(name); i++ {
		c := name[i]
		if !(c == '_' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

// Transaction runs fn once in a transaction. An error or panic rolls back.
func Transaction[T any](ctx context.Context, d *DB, fn func(*Tx) (T, error)) (T, error) {
	return TransactionWithOptions(ctx, d, TransactionOptions{}, fn)
}

// IsolationLevel is the portable transaction isolation name.
type IsolationLevel string

const (
	IsolationDefault         IsolationLevel = ""
	IsolationReadUncommitted IsolationLevel = "read_uncommitted"
	IsolationReadCommitted   IsolationLevel = "read_committed"
	IsolationRepeatableRead  IsolationLevel = "repeatable_read"
	IsolationSerializable    IsolationLevel = "serializable"
)

// TransactionOptions controls transaction mode and retry. Retry is disabled by default.
type TransactionOptions struct {
	RetryDeadlocks bool
	MaxAttempts    int
	Isolation      IsolationLevel
	ReadOnly       bool
}

// TransactionWithOptions runs a transaction with an explicit retry policy.
func TransactionWithOptions[T any](ctx context.Context, d *DB, options TransactionOptions, fn func(*Tx) (T, error)) (T, error) {
	var zero T
	var lastErr error
	attempts := 1
	if options.RetryDeadlocks {
		attempts = options.MaxAttempts
		if attempts <= 0 {
			attempts = 3
		}
	}
	for attempt := 0; attempt < attempts; attempt++ {
		v, err := runTx(ctx, d, options, fn)
		if err == nil {
			return v, nil
		}
		lastErr = err
		if !options.RetryDeadlocks || !IsDeadlock(err) {
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

func runTx[T any](ctx context.Context, d *DB, options TransactionOptions, fn func(*Tx) (T, error)) (v T, err error) {
	txOptions, err := sqlTransactionOptions(d.driver, options)
	if err != nil {
		return v, err
	}
	tx, err := d.SQL.BeginTx(ctx, txOptions)
	if err != nil {
		return v, mapDriverErr(err)
	}
	ex := &Tx{d: d, tx: tx}
	defer ex.finished.Store(true)
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
			panic(r)
		}
	}()
	v, err = fn(ex)
	if err != nil {
		tx.Rollback()
		return v, err
	}
	if err := tx.Commit(); err != nil {
		return v, mapDriverErr(err)
	}
	return v, nil
}

func sqlTransactionOptions(driver string, options TransactionOptions) (*sql.TxOptions, error) {
	if driver == "sqlite" && (options.Isolation != IsolationDefault || options.ReadOnly) {
		return nil, &ir.Error{Code: CodeConfig, Msg: "sqlite does not support transaction isolation or read-only mode"}
	}
	level := sql.LevelDefault
	switch options.Isolation {
	case IsolationDefault:
	case IsolationReadUncommitted:
		level = sql.LevelReadUncommitted
	case IsolationReadCommitted:
		level = sql.LevelReadCommitted
	case IsolationRepeatableRead:
		level = sql.LevelRepeatableRead
	case IsolationSerializable:
		level = sql.LevelSerializable
	default:
		return nil, &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf("unsupported transaction isolation %q", options.Isolation)}
	}
	return &sql.TxOptions{Isolation: level, ReadOnly: options.ReadOnly}, nil
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
	if r.Err == nil {
		r.Err = child.Err
	}
	off := len(r.Params)
	r.Params = append(r.Params, child.Params...)
	q := ir.CloneQuery(child.IR.Query)
	shiftQuery(&q, off)
	return &q
}

func shiftQuery(q *ir.Query, off int) {
	if q.ScopeP != nil {
		v := *q.ScopeP + off
		q.ScopeP = &v
	}
	shiftGroup(q.On, off)
	shiftGroup(q.Where, off)
	shiftGroup(q.Having, off)
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
	n      int             // width of a positional row (the node's columns plus its joins')
	styled []styledScanCol // columns with executor-side codec stages
}

// styledScanCol contains the split style lists once per cached plan. Row
// decoding must not repeat style parsing for every result row.
type styledScanCol struct {
	index int
	name  string
	codec []string
	host  []string
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
		c.scans[st] = &scanInfo{n: countCols(st.Assemble), styled: styledScanCols(st.Assemble)}
		walk(st.Assemble)
	}
	return c
}

// Plan compiles (or fetches from cache) the plan for the request's shape.
func (d *DB) Plan(ctx context.Context, r *Req) (*plan.Plan, error) {
	c, err := d.plan(ctx, r)
	if err != nil {
		return nil, err
	}
	return c.plan, nil
}

func (d *DB) plan(ctx context.Context, r *Req) (*cached, error) {
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
	p, err := d.compiler.Compile(ctx, &r.IR)
	if err != nil {
		return nil, err
	}
	c = newCached(key, p)
	d.planMu.Lock()
	if prev, ok := d.plans[key]; ok {
		c = prev
	} else {
		d.plans[key] = c
		d.planOrder = append(d.planOrder, key)
		for len(d.planOrder) > d.cfg.PlanCacheSize {
			oldest := d.planOrder[0]
			d.planOrder = d.planOrder[1:]
			delete(d.plans, oldest)
		}
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
				if slices.Contains(b.HostStyles, "blind_index") {
					if len(b.HostStyles) != 1 {
						return nil, nil, &ir.Error{Code: CodeConfig, Msg: "blind_index must be the only host style"}
					}
					if v == nil {
						v = nil
					} else if v, err = BlindIndex(v, d.cfg.BlindIndexKey); err != nil {
						return nil, nil, err
					}
				} else if v, err = HostEncode(v, b.HostStyles, d.cfg.AESKey); err != nil {
					return nil, nil, err
				}
			}
			if b.ColType == "point" && v != nil {
				p, e := ParsePoint(v)
				if e != nil {
					return nil, nil, e
				}
				if d.driver == "postgres" {
					v, err = postgresPointText(p)
				} else {
					v, err = PointText(p)
				}
				if err != nil {
					return nil, nil, err
				}
			}
			out = append(out, v)
		case "secret":
			if masks == nil {
				masks = map[int]string{}
			}
			masks[len(out)] = Secret
			switch b.Name {
			case "aes":
				if d.cfg.AESKey == "" {
					return nil, nil, &ir.Error{Code: CodeConfig, Msg: "secret aes not configured"}
				}
				out = append(out, d.cfg.AESKey)
			default:
				return nil, nil, &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf("secret %q not configured", b.Name)}
			}
		case "config":
			if b.Name != "aes_version" {
				return nil, nil, &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf("config value %q not configured", b.Name)}
			}
			version := d.cfg.AESVersion
			if version == 0 {
				version = 1
			}
			if version < 1 {
				return nil, nil, &ir.Error{Code: CodeConfig, Msg: "aes version must be positive"}
			}
			out = append(out, version)
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
	p, err := ex.db().Plan(ctx, r)
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
		case "config":
			if b.Name != "aes_version" {
				return nil, &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf("config value %q not configured", b.Name)}
			}
			version := ex.DB().cfg.AESVersion
			if version == 0 {
				version = 1
			}
			if version < 1 {
				return nil, &ir.Error{Code: CodeConfig, Msg: "aes version must be positive"}
			}
			out.Binds = append(out.Binds, version)
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
	Binding  Binding
	Assemble *plan.Assemble
	Data     [][]any
	c        *cached
	steps    map[int]*stepRows
	params   []any
}

// StreamResult reports how a row stream finished. Count is the number of rows
// delivered to the visitor. State is exhausted when the query ended normally
// and stopped when the visitor returned false.
type StreamResult struct {
	State string
	Count int64
}

const (
	StreamExhausted = "exhausted"
	StreamStopped   = "stopped"
	StreamFailed    = "failed"
	StreamCancelled = "cancelled"
)

func streamErrorState(err error) string {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return StreamCancelled
	}
	return StreamFailed
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
	key, ok := KeyFromRow(parent, ch.ParentKeys)
	if !ok {
		return nil
	}
	idxs := sr.byKey[key]
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
	c, err := d.plan(ctx, r)
	if err != nil {
		return nil, err
	}
	return runPlan(ctx, ex, c, r)
}

// DirectScanner gives generated code the current database row and immutable
// plan metadata. Generated scanners pass typed struct fields to Scan and use
// Decode only for expression and application-codec outputs.
type DirectScanner struct {
	rows    *sql.Rows
	db      *DB
	step    *plan.Step
	context *Rows
}

func (s *DirectScanner) Assemble() *plan.Assemble { return s.step.Assemble }
func (s *DirectScanner) Binding() Binding         { return s.context.Binding }
func (s *DirectScanner) Projection() *Projection  { return s.context.Projection(s.step.Assemble) }

func (s *DirectScanner) Scan(dest ...any) error {
	return mapDriverErr(s.rows.Scan(dest...))
}

func (s *DirectScanner) Decode(c plan.OutCol, value any) (any, error) {
	codec, host := splitHost(c.Styles)
	var err error
	if len(host) > 0 {
		if value, err = hostDecode(value, host, s.db.cfg.AESKey); err != nil {
			return nil, fmt.Errorf("%s.%s: %w", s.step.Assemble.Entity, c.Name, err)
		}
	}
	if len(codec) > 0 {
		if value, err = Decode(codec, value); err != nil {
			return nil, fmt.Errorf("%s.%s: %w", s.step.Assemble.Entity, c.Name, err)
		}
	}
	return value, nil
}

// QueryDirect executes a flat select directly into generated typed rows. It
// returns used=false without executing SQL when the plan contains joins,
// relations, or additional steps; callers then use Query for full assembly.
func QueryDirect[T any](ctx context.Context, ex Exec, r *Req, accepts func(*plan.Assemble) bool, scan func(*DirectScanner) (*T, error)) (out []*T, used bool, err error) {
	d := ex.db()
	c, err := d.plan(ctx, r)
	if err != nil {
		return nil, true, err
	}
	if len(c.plan.Steps) != 1 || c.plan.Steps[0].Assemble == nil || len(c.plan.Steps[0].Assemble.Children) != 0 || !accepts(c.plan.Steps[0].Assemble) {
		return nil, false, nil
	}
	st := &c.plan.Steps[0]
	for _, col := range st.Assemble.Columns {
		for _, style := range col.Styles {
			if style == "aes" {
				return nil, false, nil
			}
		}
	}
	args, masks, err := d.args(st, r, nil)
	if err != nil {
		return nil, true, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return nil, true, err
	}
	start := time.Now()
	rows, err := stmt.QueryContext(ctx, args...)
	err = mapDriverErr(err)
	if err != nil {
		d.emit(c, st.SQL, args, masks, start, err)
		return nil, true, err
	}
	defer rows.Close()
	context := &Rows{Binding: NewBinding(ctx, ex), Assemble: st.Assemble, c: c, params: r.Params}
	scanner := &DirectScanner{rows: rows, db: d, step: st, context: context}
	for rows.Next() {
		var row *T
		row, err = scan(scanner)
		if err != nil {
			break
		}
		out = append(out, row)
	}
	if err == nil {
		err = mapDriverErr(rows.Err())
	}
	d.emit(c, st.SQL, args, masks, start, err)
	return out, true, err
}

// Stream runs a single select step and delivers one independently owned row at
// a time. Separate relation steps are rejected because they require additional
// statements while the root cursor is open. SQL joins remain supported.
func Stream(ctx context.Context, ex Exec, r *Req, visit func([]any, *Rows) bool) (StreamResult, error) {
	d := ex.db()
	c, err := d.plan(ctx, r)
	if err != nil {
		return StreamResult{State: streamErrorState(err)}, err
	}
	for _, st := range c.plan.Steps[1:] {
		if st.Role == "relation" {
			err := &ir.Error{Code: CodeIrInvalid, Msg: "stream does not support separate relation steps; use a join or gets"}
			return StreamResult{State: StreamFailed}, err
		}
	}
	st := &c.plan.Steps[0]
	context := &Rows{Binding: NewBinding(ctx, ex), Assemble: st.Assemble, c: c, params: r.Params}
	return streamSelect(ctx, ex, c, st, r, func(vals []any) bool { return visit(vals, context) })
}

func runPlan(ctx context.Context, ex Exec, c *cached, r *Req) (*Rows, error) {
	d := ex.db()
	p := c.plan
	main, err := runSelect(ctx, ex, c, &p.Steps[0], r, nil)
	if err != nil {
		return nil, err
	}
	out := &Rows{Binding: NewBinding(ctx, ex), Assemble: p.Steps[0].Assemble, Data: main, c: c, params: r.Params}
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
			chunks, chunkErr := relationChunks(st, vals, d.Driver())
			if chunkErr != nil {
				return nil, chunkErr
			}
			for _, chunk := range chunks {
				part, runErr := runSelect(ctx, ex, c, st, r, chunk)
				if runErr != nil {
					return nil, runErr
				}
				sr.data = append(sr.data, part...)
			}
			keys := childKeys(p, st)
			for j, row := range sr.data {
				if key, ok := KeyFromRow(row, keys); ok {
					sr.byKey[key] = append(sr.byKey[key], j)
				}
			}
		}
		out.steps[st.ID] = sr
	}
	return out, nil
}

// relationChunks bounds one relation query by the driver's bind limit. The
// chunk size is the largest power of two that fits, so expandIn keeps a
// logarithmic statement set without ever exceeding the limit.
func relationChunks(st *plan.Step, vals []any, driver string) ([][]any, error) {
	width := len(st.Parent.Keys)
	if width == 0 || len(vals)%width != 0 {
		return nil, &ir.Error{Code: CodeIrInvalid, Msg: fmt.Sprintf("relation %d has invalid parent key values", st.ID)}
	}
	nonParent := 0
	for _, bind := range st.BindSlots {
		if bind.From != "parent" {
			nonParent++
		}
	}
	limit := 65535
	if driver == "sqlite" {
		limit = 999
	}
	maxTuples := (limit - nonParent) / width
	if maxTuples < 1 {
		return nil, &ir.Error{Code: CodeIrInvalid, Msg: fmt.Sprintf("relation %d needs %d bind parameters but %s permits %d", st.ID, nonParent+width, driver, limit)}
	}
	chunkTuples := 1
	for chunkTuples*2 <= maxTuples {
		chunkTuples *= 2
	}
	tuples := len(vals) / width
	out := make([][]any, 0, (tuples+chunkTuples-1)/chunkTuples)
	for start := 0; start < tuples; start += chunkTuples {
		end := start + chunkTuples
		if end > tuples {
			end = tuples
		}
		chunk := make([]any, (end-start)*width)
		copy(chunk, vals[start*width:end*width])
		out = append(out, chunk)
	}
	return out, nil
}

// childKeys finds the ordered match key of a relation step.
func childKeys(p *plan.Plan, st *plan.Step) []plan.KeyRef {
	var find func(a *plan.Assemble) []plan.KeyRef
	find = func(a *plan.Assemble) []plan.KeyRef {
		for _, ch := range a.Children {
			if ch.Kind != "join" && ch.Step == st.ID {
				return ch.ChildKeys
			}
			if ch.Kind == "join" {
				if keys := find(ch.Assemble); len(keys) > 0 {
					return keys
				}
			}
		}
		return nil
	}
	for i := range p.Steps {
		if p.Steps[i].Assemble != nil {
			if keys := find(p.Steps[i].Assemble); len(keys) > 0 {
				return keys
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
		key, ok := KeyFromRow(row, pr.Keys)
		if !ok {
			continue
		}
		if !seen[key] {
			seen[key] = true
			for _, ref := range pr.Keys {
				out = append(out, row[ref.Index])
			}
		}
	}
	return out
}

// expandIn rewrites the step's single `parent` placeholder into n placeholders.
// n is rounded up to a power of two (values are padded by repetition) so the
// prepared-statement cache holds one statement per size class, not per size.
func expandIn(st *plan.Step, vals []any) (string, []any) {
	width := len(st.Parent.Keys)
	if width == 0 || len(vals)%width != 0 {
		panic("orm: invalid relation parent key values")
	}
	tuples := len(vals) / width
	n := 1
	for n < tuples {
		n <<= 1
	}
	padded := make([]any, n*width)
	copy(padded, vals)
	for i := tuples; i < n; i++ {
		copy(padded[i*width:(i+1)*width], vals[(tuples-1)*width:tuples*width])
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
				for m := 0; m < n*width; m++ {
					if m > 0 {
						if width > 1 && m%width == 0 {
							sb.WriteString("), (")
						} else {
							sb.WriteString(", ")
						}
					}
					sb.WriteString("$" + strconv.Itoa(k+m))
				}
			case k > parent:
				sb.WriteString("$" + strconv.Itoa(k+n*width-1))
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
			for m := 0; m < n*width; m++ {
				if m > 0 {
					if width > 1 && m%width == 0 {
						sb.WriteString("), (")
					} else {
						sb.WriteString(", ")
					}
				}
				sb.WriteByte('?')
			}
		} else {
			sb.WriteByte('?')
		}
		slot++
	}
	return sb.String(), padded
}

// ScanValue receives a column that requires application decoding or runtime
// type conversion. Generated direct scanners use typed field pointers for all
// other columns.
type ScanValue struct{ v any }

func (c *ScanValue) Scan(src any) error {
	if b, ok := src.([]byte); ok {
		c.v = string(b)
		return nil
	}
	c.v = src
	return nil
}

func (c *ScanValue) Value() any { return c.v }

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
	var keyring AESKeyring
	if assembleHasAES(st.Assemble) {
		var keyErr error
		keyring, keyErr = d.aesKeyring()
		if keyErr != nil {
			return nil, keyErr
		}
	}
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
		if err := decodeSelectedRow(vals, si, st, keyring); err != nil {
			return nil, err
		}
		out = append(out, vals)
	}
	return out, mapDriverErr(rows.Err())
}

func decodeSelectedRow(vals []any, si *scanInfo, st *plan.Step, keyring AESKeyring) error {
	version := int32(1)
	for _, col := range st.Assemble.Columns {
		if col.Hidden && col.Column == "aes_key_version" {
			var err error
			version, err = rowVersion(vals[col.Index])
			if err != nil {
				return fmt.Errorf("%s.%s: %w", st.Assemble.Entity, col.Name, err)
			}
			break
		}
	}
	for _, sc := range si.styled {
		v := vals[sc.index]
		if v == nil {
			continue
		}
		var err error
		if len(sc.host) > 0 {
			if v, err = HostDecodeVersioned(v, sc.host, version, keyring); err != nil {
				return fmt.Errorf("%s.%s: %w", st.Assemble.Entity, sc.name, err)
			}
		}
		if len(sc.codec) > 0 {
			if v, err = Decode(sc.codec, v); err != nil {
				return fmt.Errorf("%s.%s: %w", st.Assemble.Entity, sc.name, err)
			}
		}
		vals[sc.index] = v
	}
	return nil
}

func styledScanCols(a *plan.Assemble) []styledScanCol {
	var out []styledScanCol
	for _, c := range a.Columns {
		if len(c.Styles) == 0 {
			continue
		}
		codec, host := splitHost(c.Styles)
		out = append(out, styledScanCol{index: c.Index, name: c.Name, codec: codec, host: host})
	}
	for _, ch := range a.Children {
		if ch.Kind == "join" {
			out = append(out, styledScanCols(ch.Assemble)...)
		}
	}
	return out
}

func streamSelect(ctx context.Context, ex Exec, c *cached, st *plan.Step, r *Req, visit func([]any) bool) (result StreamResult, err error) {
	d := ex.db()
	args, masks, err := d.args(st, r, nil)
	if err != nil {
		result.State = streamErrorState(err)
		return result, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		result.State = streamErrorState(err)
		return result, err
	}
	start := time.Now()
	rows, err := stmt.QueryContext(ctx, args...)
	if err != nil {
		err = mapDriverErr(err)
		result.State = streamErrorState(err)
		d.emit(c, st.SQL, args, masks, start, err)
		return result, err
	}
	defer rows.Close()
	si := c.scans[st]
	cells := make([]cell, si.n)
	ptrs := make([]any, si.n)
	for i := range cells {
		ptrs[i] = &cells[i]
	}
	result.State = StreamExhausted
	for rows.Next() {
		if err = rows.Scan(ptrs...); err != nil {
			err = mapDriverErr(err)
			break
		}
		vals := make([]any, si.n)
		for i := range cells {
			vals[i] = cells[i].v
		}
		var keyring AESKeyring
		if assembleHasAES(st.Assemble) {
			var keyErr error
			keyring, keyErr = d.aesKeyring()
			if keyErr != nil {
				return result, keyErr
			}
		}
		if err = decodeSelectedRow(vals, si, st, keyring); err != nil {
			break
		}
		result.Count++
		if !visit(vals) {
			result.State = StreamStopped
			break
		}
	}
	if err == nil && result.State == StreamExhausted {
		err = mapDriverErr(rows.Err())
	}
	if err != nil {
		result.State = streamErrorState(err)
	}
	d.emit(c, st.SQL, args, masks, start, err)
	return result, err
}

func assembleHasAES(asm *plan.Assemble) bool {
	if asm == nil {
		return false
	}
	for _, col := range asm.Columns {
		for _, style := range col.Styles {
			if style == "aes" {
				return true
			}
		}
	}
	for _, child := range asm.Children {
		if assembleHasAES(child.Assemble) {
			return true
		}
	}
	return false
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
	c, err := d.plan(ctx, r)
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
	c, err := d.plan(ctx, r)
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
	c, err := d.plan(ctx, r)
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
	c, err := d.plan(ctx, r)
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
	case bool:
		if x {
			return Key{S: "1", isStr: true}
		}
		return Key{S: "0", isStr: true}
	case nil:
		return Key{S: "", isStr: true}
	}
	return Key{S: fmt.Sprint(v), isStr: true}
}

// KeyFromRow creates one comparable key from an ordered set of result columns.
// It returns false when any key component is SQL NULL.
func KeyFromRow(row []any, refs []plan.KeyRef) (Key, bool) {
	if len(refs) == 1 {
		v := row[refs[0].Index]
		return KeyOf(v), v != nil
	}
	var b strings.Builder
	for _, ref := range refs {
		v := row[ref.Index]
		if v == nil {
			return Key{}, false
		}
		part := scalarKey(v)
		b.WriteString(strconv.Itoa(len(part)))
		b.WriteByte(':')
		b.WriteString(part)
	}
	return Key{S: b.String(), isStr: true}, true
}

// KeyFromValues creates the same collision-free collection key from values
// already decoded into a generated row.
func KeyFromValues(values []any) Key {
	if len(values) == 1 {
		return KeyOf(values[0])
	}
	var b strings.Builder
	for _, value := range values {
		part := scalarKey(value)
		b.WriteString(strconv.Itoa(len(part)))
		b.WriteByte(':')
		b.WriteString(part)
	}
	return Key{S: b.String(), isStr: true}
}

func (k Key) String() string {
	if k.isStr {
		return k.S
	}
	return fmt.Sprint(k.I)
}

// Value preserves the key's integer/string distinction.
func (k Key) Value() any {
	if k.isStr {
		return k.S
	}
	return k.I
}

// Collection is an ordered map keyed by PK (or key_by). Never nil from a terminal.
type Collection[T any] struct {
	keys  []Key
	items map[Key]*T
}

func NewCollection[T any](n int) *Collection[T] {
	return &Collection[T]{keys: make([]Key, 0, n), items: make(map[Key]*T, n)}
}

// RowExport is the common fallible row conversion boundary.
type RowExport interface {
	ToArray() (map[string]any, error)
}

// ToArray refuses collisions introduced by a string-keyed representation.
func (c *Collection[T]) ToArray() (map[string]any, error) {
	out := make(map[string]any, c.Len())
	for k, v := range c.All() {
		key := k.String()
		if _, ok := out[key]; ok {
			return nil, &ir.Error{Code: CodeIrInvalid, Msg: "array conversion loses key type; use entries"}
		}
		row, ok := any(v).(RowExport)
		if !ok {
			return nil, &ir.Error{Code: CodeConfig, Msg: "collection value does not implement row export"}
		}
		value, err := row.ToArray()
		if err != nil {
			return nil, err
		}
		out[key] = value
	}
	return out, nil
}

func (c *Collection[T]) Put(k Key, v *T) {
	if _, ok := c.items[k]; !ok {
		c.keys = append(c.keys, k)
	}
	c.items[k] = v
}

func (c *Collection[T]) Get(k Key) *T { return c.items[k] }
func (c *Collection[T]) Len() int     { return len(c.keys) }

func (c *Collection[T]) Keys() []Key { return append([]Key(nil), c.keys...) }

type Entry[T any] struct {
	Key   Key
	Value *T
}

func (c *Collection[T]) Entries() []Entry[T] {
	out := make([]Entry[T], 0, len(c.keys))
	for _, k := range c.keys {
		out = append(out, Entry[T]{Key: k, Value: c.items[k]})
	}
	return out
}

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
