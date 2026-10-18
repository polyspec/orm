package orm

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"maps"
	"math/rand/v2"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
)

// executor is where a statement runs: a connection or an active transaction.
type executor interface {
	base() *DB
	context() context.Context
	stmt(ctx context.Context, sqlText string) (*sql.Stmt, error)
	transaction() *txConn
	// requestHook is the request hook of the handle that the statement passes through, or nil if there is none.
	requestHook() RequestHook
	// enter marks the start of a statement and returns its end; a
	// transaction rejects concurrent use.
	enter() (func(), error)
}

func (d *DB) base() *DB                { return d }
func (d *DB) context() context.Context { return d.ctx }
func (d *DB) transaction() *txConn     { return nil }
func (d *DB) requestHook() RequestHook { return d.hook }
func (d *DB) enter() (func(), error) {
	if d.m.closed.Load() {
		return nil, configErr("database is closed")
	}
	return func() {}, nil
}

// txConn is one active transaction.
type txConn struct {
	db *DB
	// conn is the pool connection held until the transaction ends. It checks whether the driver closed the connection when rollback
	// fails.
	conn *sql.Conn
	// md is the flowmark session held until the markdown connection's transaction ends.
	// On SQL connections it is nil, and conn takes its place.
	md *mdSession
	// number is this transaction's number on the connection. A statement event carries it.
	number     int64
	ctx        context.Context
	cancel     context.CancelFunc
	busy       atomic.Bool
	finished   atomic.Bool
	savepoints int
	stmMu      sync.Mutex
	stmts      map[string]*sql.Stmt
	locals     map[string]string
	locks      []string
	// unclean is whether one of the cleanups at the end of the transaction (SQLite mode, named lock, local values) failed. A failed
	// cleanup leaves the session state unknown, so that connection is discarded rather than returned to the pool.
	unclean    bool
	readOnly   bool
	isolation  IsolationLevel
	sqliteMode bool
	// audit is the audit record inserted when this transaction (unit of work) started.
	// The audit table's insert and update write that key to the audit column. If there is none,
	// it is nil.
	audit *auditRecord
	// inserted records generated ORM inserts that succeeded in this
	// transaction. It is an adapter-neutral transaction fact used by callers
	// that must distinguish a row created in this transaction from a matching
	// row committed earlier.
	inserted map[string]map[int64]struct{}
}

func (t *txConn) base() *DB                { return t.db }
func (t *txConn) context() context.Context { return t.ctx }
func (t *txConn) requestHook() RequestHook { return t.db.hook }
func (t *txConn) transaction() *txConn     { return t }

func (t *txConn) enter() (func(), error) {
	if t.finished.Load() {
		return nil, configErr("transaction already finished")
	}
	if !t.busy.CompareAndSwap(false, true) {
		return nil, configErr("the transaction connection is already in use")
	}
	return func() { t.busy.Store(false) }, nil
}

// stmt prepares on the transaction connection and keeps the statement until
// the transaction ends.
func (t *txConn) stmt(ctx context.Context, sqlText string) (*sql.Stmt, error) {
	t.stmMu.Lock()
	defer t.stmMu.Unlock()
	if st, ok := t.stmts[sqlText]; ok {
		return st, nil
	}
	st, err := t.conn.PrepareContext(ctx, sqlText)
	if err != nil {
		return nil, mapDriverErr(err)
	}
	if t.stmts == nil {
		t.stmts = map[string]*sql.Stmt{}
	}
	t.stmts[sqlText] = st
	return st, nil
}

// run sends a statement on the transaction connection and publishes its event.
func (t *txConn) run() runner { return runner{d: t.db, q: t.conn, tx: t.number} }

// machinery is the runner for statements of transaction-opening settings, the SQLite mode setting, and end-of-transaction cleanup.
// These statements do not consume the statement fault.
func (t *txConn) machinery() runner {
	r := t.run()
	r.machinery = true
	return r
}

func (t *txConn) closeStatements() {
	t.stmMu.Lock()
	defer t.stmMu.Unlock()
	for _, st := range t.stmts {
		_ = st.Close()
	}
	t.stmts = nil
}

// flows maps a goroutine to its stack of active transactions. A goroutine
// started inside a callback has its own, empty stack.
var flows sync.Map

// openFrames counts the transaction frames of every flow; with none open a
// flow lookup needs no goroutine id.
var openFrames atomic.Int64

func goroutineID() uint64 {
	var buf [64]byte
	b := buf[:runtime.Stack(buf[:], false)]
	b = bytes.TrimPrefix(b, []byte("goroutine "))
	if i := bytes.IndexByte(b, ' '); i > 0 {
		b = b[:i]
	}
	id, _ := strconv.ParseUint(string(b), 10, 64)
	return id
}

type flowStack struct{ frames []*txConn }

func currentFlow() *flowStack {
	if openFrames.Load() == 0 {
		return nil
	}
	if v, ok := flows.Load(goroutineID()); ok {
		return v.(*flowStack)
	}
	return nil
}

func pushFrame(t *txConn) {
	id := goroutineID()
	v, _ := flows.LoadOrStore(id, &flowStack{})
	s := v.(*flowStack)
	s.frames = append(s.frames, t)
	openFrames.Add(1)
}

func popFrame() {
	id := goroutineID()
	v, ok := flows.Load(id)
	if !ok {
		return
	}
	s := v.(*flowStack)
	s.frames = s.frames[:len(s.frames)-1]
	openFrames.Add(-1)
	if len(s.frames) == 0 {
		flows.Delete(id)
	}
}

// activeFor returns the innermost active transaction of db in this flow. A
// context handle is the same connection, so frames are matched by connection.
func activeFor(db *DB) *txConn {
	s := currentFlow()
	if s == nil {
		return nil
	}
	for i := len(s.frames) - 1; i >= 0; i-- {
		if s.frames[i].db.m == db.m {
			return s.frames[i]
		}
	}
	return nil
}

func innermost() *txConn {
	s := currentFlow()
	if s == nil || len(s.frames) == 0 {
		return nil
	}
	return s.frames[len(s.frames)-1]
}

// resolve selects where a model runs: the active transaction of its
// connection, the connection itself, or the innermost active transaction
// for a model without a connection.
// txContext runs on an active transaction with the context of the connection
// handle the model was connected to, so a handle from WithContext cancels
// statements that run inside the transaction as well.
// It also carries that handle's request hook, for the same reason.
type txContext struct {
	*txConn
	ctx  context.Context
	hook RequestHook
}

func (t txContext) context() context.Context { return t.ctx }
func (t txContext) requestHook() RequestHook { return t.hook }

func resolve(conn *DB) (executor, error) {
	if conn != nil {
		if t := activeFor(conn); t != nil {
			ctx := t.ctx
			if conn.ctx != t.ctx && conn.ctx != nil {
				ctx = conn.ctx
			}
			// It uses the hook of the handle the model is connected to. If neither the handle that started the transaction nor the hook has one, it passes through as is.
			if ctx != t.ctx || conn.hook != nil || t.db.hook != nil {
				return txContext{txConn: t, ctx: ctx, hook: conn.hook}, nil
			}
			return t, nil
		}
		if conn.m.closed.Load() {
			return nil, configErr("database is closed")
		}
		return conn, nil
	}
	if t := innermost(); t != nil {
		return t, nil
	}
	return nil, configErr("the model has no connection; use connect or run it inside a transaction")
}

// IsolationLevel is a transaction isolation level.
type IsolationLevel string

const (
	ReadUncommitted IsolationLevel = "read_uncommitted"
	ReadCommitted   IsolationLevel = "read_committed"
	RepeatableRead  IsolationLevel = "repeatable_read"
	Serializable    IsolationLevel = "serializable"
)

type txOptions struct {
	isolation IsolationLevel
	readOnly  bool
	timeoutMs int
	retry     int
	audit     map[string]any
	auditSet  bool
	set       bool
}

// auditRecord is the table and primary key value of the audit record the transaction inserted.
type auditRecord struct {
	table string
	key   any
}

// TransactionOption configures a transaction.
type TransactionOption func(*txOptions)

// Isolation sets the isolation level.
func Isolation(level IsolationLevel) TransactionOption {
	return func(o *txOptions) { o.isolation, o.set = level, true }
}

// ReadOnly makes the transaction read-only.
func ReadOnly() TransactionOption {
	return func(o *txOptions) { o.readOnly, o.set = true, true }
}

// TimeoutMs sets the statement timeout in milliseconds (PostgreSQL only).
func TimeoutMs(ms int) TransactionOption {
	return func(o *txOptions) { o.timeoutMs, o.set = ms, true }
}

// Audit makes the transaction one unit of work with an audit record. Before
// the callback, in every attempt, the transaction inserts one row into the
// audit record table, the table that the audit settings of the registered sets
// name with references: the values of Config.AuditSource, called once for the
// transaction, with values, a map from column name to value, of which a value
// wins over the source's value of the same column. Every insert, update, soft
// delete and restore of an audited table in the transaction writes the record's
// primary key into the table's audit column. The connection must have an audit
// source, and every key must be a column of the audit record table; otherwise
// the transaction fails with CodeConfig before it begins, and an error of the
// source fails it as well. A nested transaction uses the audit of the outer one
// and accepts only orm.Retry.
func Audit(values map[string]any) TransactionOption {
	return func(o *txOptions) { o.audit, o.auditSet, o.set = maps.Clone(values), true, true }
}

// auditInsert is the audit record the transaction will insert: the entity of the record table and
// the schema and column values of the entity.
type auditInsert struct {
	schema *Schema
	ent    *runtimemodel.Entity
	values map[string]any
}

// auditRecord is the audit record that adds the transaction's values to the audit source's values.
// For the same column, the transaction's value wins. The record table is the one table named by the references
// audit setting of the set registered on the connection, and the set that has that table as an entity
// must be registered on the connection. If there is no audit source, no record table, or
// more than one, or a value key is not a column of that table, or the primary key is not
// a single column, it is CONFIG; an error from the source is returned as is.
func (d *DB) auditRecord(values map[string]any) (*auditInsert, error) {
	if d.cfg.AuditSource == nil {
		return nil, configErr("the transaction has audit values but the connection has no audit source: set Config.AuditSource")
	}
	d.m.engineMu.RLock()
	var tables []string
	for _, eng := range d.m.engines {
		for _, name := range eng.M.Order {
			if a := eng.M.Entities[name].Audit; a != nil && !slices.Contains(tables, a.Record) {
				tables = append(tables, a.Record)
			}
		}
	}
	slices.Sort(tables)
	var target *auditInsert
	if len(tables) == 1 {
		for hash, eng := range d.m.engines {
			for _, name := range eng.M.Order {
				if e := eng.M.Entities[name]; e.Table == tables[0] && !e.External {
					target = &auditInsert{schema: d.m.schemas[hash], ent: e}
				}
			}
		}
	}
	d.m.engineMu.RUnlock()
	switch {
	case len(tables) == 0:
		return nil, configErr("the transaction has audit values but no set of the connection has an audited table")
	case len(tables) > 1:
		return nil, configErr("the audited tables of the connection record their audits in %s; one audit record table is required", strings.Join(tables, ", "))
	case target == nil:
		return nil, configErr("the audit record table %s is not a table of a set registered on the connection", tables[0])
	case len(target.ent.PK) != 1:
		return nil, configErr("the audit record table %s needs a primary key of one column", tables[0])
	}
	source, err := d.cfg.AuditSource(d.ctx)
	if err != nil {
		return nil, err
	}
	target.values = map[string]any{}
	for _, set := range []map[string]any{source, values} {
		for _, column := range slices.Sorted(maps.Keys(set)) {
			if target.ent.Field(column) == nil {
				return nil, configErr("audit value %s is not a column of %s", column, target.ent.Table)
			}
			target.values[column] = set[column]
		}
	}
	if len(target.values) == 0 {
		return nil, configErr("the audit record of %s has no value: the audit source and the transaction give none", target.ent.Table)
	}
	return target, nil
}

// insertAudit inserts the transaction's audit record and returns its table and primary key
// value. If the primary key is an identity, it is the generated key; otherwise it is the record's value.
// It inserts again on every attempt.
func (d *DB) insertAudit(ex executor, a *auditInsert) (*auditRecord, error) {
	r := &request{schema: a.schema}
	r.ir.IRVersion = ir.Version
	r.ir.ManifestHash = a.schema.Hash
	r.ir.Kind = "insert"
	r.ir.Entity = a.ent.Name
	for _, column := range slices.Sorted(maps.Keys(a.values)) {
		assign, err := r.assign(a.ent, setSpec{column: column, value: a.values[column], null: a.values[column] == nil})
		if err != nil {
			return nil, err
		}
		r.ir.Set = append(r.ir.Set, assign)
	}
	r.ir.NParams = len(r.params)
	id, _, err := write(ex, r)
	if err != nil {
		return nil, err
	}
	key := a.values[a.ent.PK[0]]
	if a.ent.Field(a.ent.PK[0]).Identity {
		key = id
	}
	if key == nil {
		return nil, configErr("the audit record %s has no %s after its insert", a.ent.Table, a.ent.PK[0])
	}
	return &auditRecord{table: a.ent.Table, key: key}, nil
}

// Retry sets how many times a deadlocked callback runs again; 0 disables retry.
func Retry(n int) TransactionOption {
	return func(o *txOptions) { o.retry = n }
}

// Transaction runs fn in one transaction. An error or panic rolls back;
// otherwise the transaction commits. Models without connect inside fn use
// this transaction. A transaction of the same connection inside an active one
// creates a savepoint.
func (d *DB) Transaction(fn func() error, options ...TransactionOption) error {
	o := txOptions{retry: 3}
	for _, option := range options {
		option(&o)
	}
	if o.retry < 0 {
		return configErr("transaction retry must not be negative")
	}
	if o.timeoutMs < 0 {
		return configErr("transaction timeoutMs must not be negative")
	}
	if o.auditSet {
		if err := d.unsupportedOnMarkdown("a transaction with audit values"); err != nil {
			return err
		}
	}
	if o.auditSet && activeFor(d) == nil {
		record, err := d.auditRecord(o.audit)
		if err != nil {
			return err
		}
		inner := fn
		fn = func() error {
			t := activeFor(d)
			a, err := d.insertAudit(t, record)
			if err != nil {
				return err
			}
			t.audit = a
			return inner()
		}
	}
	if outer := activeFor(d); outer != nil {
		if o.set {
			return configErr("a nested transaction of the same connection accepts only the retry option")
		}
		return outer.savepoint(fn)
	}
	var err error
	for attempt := 0; ; attempt++ {
		err = d.runTransaction(fn, o)
		if err == nil || !IsDeadlock(err) || attempt >= o.retry {
			return err
		}
		delay := time.Duration(50<<attempt)*time.Millisecond + time.Duration(rand.IntN(20))*time.Millisecond
		time.Sleep(delay)
	}
}

func (d *DB) runTransaction(fn func() error, o txOptions) (err error) {
	t, err := d.begin(o)
	if err != nil {
		return err
	}
	pushFrame(t)
	// A callback can leave without returning: it can panic, and in a test it
	// can call runtime.Goexit through t.Fatal. Both end the transaction.
	returned := false
	defer func() {
		popFrame()
		// If a callback leaves without returning, no caller receives an error, so the failed
		// rollback is reported as a panic.
		if r := recover(); r != nil {
			if rollbackErr := t.rollback(); rollbackErr != nil {
				panic(rollbackFailed(r, rollbackErr))
			}
			panic(r)
		}
		if !returned {
			if rollbackErr := t.rollback(); rollbackErr != nil {
				panic(rollbackFailed("callback exited without returning", rollbackErr))
			}
		}
	}()
	err = fn()
	returned = true
	if err != nil {
		if rollbackErr := t.rollback(); rollbackErr != nil {
			return rollbackFailed(err, rollbackErr)
		}
		if d.m.rollbackFault.CompareAndSwap(true, false) {
			return rollbackFailed(err, rollbackFaultErr())
		}
		return err
	}
	return t.commit()
}

// rollbackFailed reports the cause that ended the transaction or savepoint and the failed rollback
// as one ROLLBACK error (docs/errors.yaml, docs/interfaces.md). The error's
// Cause is the errors.Join of the cause and the rollback error, so errors.Is and errors.As find both
// of them. A cause that is not an error, such as a panic value, becomes an error with that text.
func rollbackFailed(cause any, rollbackErr error) error {
	causeErr, ok := cause.(error)
	if !ok {
		causeErr = errors.New(fmt.Sprint(cause))
	}
	return &ir.Error{Code: CodeRollback, Msg: fmt.Sprintf("transaction failed (%v) and rollback failed (%v)", causeErr, rollbackErr), Cause: errors.Join(causeErr, rollbackErr)}
}

// rollbackAfter rolls back a transaction that ends with cause, and returns the cause.
// If the rollback also fails, it returns both errors together.
func (t *txConn) rollbackAfter(cause error) error {
	if rollbackErr := t.rollback(); rollbackErr != nil {
		return rollbackFailed(cause, rollbackErr)
	}
	return cause
}

// rollbackFaultErr is the rollback error that a set test fault reports after the rollback runs
// (FailNextRollback, build tag ormtest).
func rollbackFaultErr() error {
	return &ir.Error{Code: CodeFault, Msg: "test fault: the rollback of the transaction ran and is reported as failed"}
}

func (d *DB) begin(o txOptions) (*txConn, error) {
	if d.m.closed.Load() {
		return nil, configErr("database is closed")
	}
	if o.timeoutMs > 0 && d.driver != "postgres" {
		return nil, &ir.Error{Code: CodeCapabilityUnsupported, Msg: "transaction timeoutMs is supported only by postgres"}
	}
	if d.md != nil {
		return d.beginMarkdown(o)
	}
	level := ""
	switch o.isolation {
	case "":
	case ReadUncommitted:
		level = "READ UNCOMMITTED"
	case ReadCommitted:
		level = "READ COMMITTED"
	case RepeatableRead:
		level = "REPEATABLE READ"
	case Serializable:
		level = "SERIALIZABLE"
	default:
		return nil, configErr("unsupported transaction isolation %q", o.isolation)
	}
	if d.driver == "sqlite" {
		// SQLite's row lock table is created once, before the connection's first transaction.
		if err := ensureSQLiteRowLock(d.ctx, d); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithCancel(d.ctx)
	conn, err := d.sql.Conn(ctx)
	if err != nil {
		cancel()
		return nil, mapDriverErr(err)
	}
	t := &txConn{db: d, conn: conn, ctx: ctx, cancel: cancel, readOnly: o.readOnly, isolation: o.isolation, number: d.nextTransaction()}
	// Statements that open a transaction (docs/usage.md "Statement events"). If any one of them
	// fails, the connection is closed so that settings left in the session do not reach the next user.
	type opening struct{ kind, sql string }
	var steps []opening
	switch d.driver {
	case "mysql":
		if level != "" {
			steps = append(steps, opening{KindUtility, "SET TRANSACTION ISOLATION LEVEL " + level})
		}
		begin := "START TRANSACTION"
		if o.readOnly {
			begin += " READ ONLY"
		}
		steps = append(steps, opening{KindBegin, begin})
	case "postgres":
		begin := "BEGIN"
		if level != "" {
			begin += " ISOLATION LEVEL " + level
		}
		if o.readOnly {
			begin += " READ ONLY"
		}
		steps = append(steps, opening{KindBegin, begin})
		if o.timeoutMs > 0 {
			steps = append(steps, opening{KindUtility, fmt.Sprintf("SET LOCAL statement_timeout = %d", o.timeoutMs)})
		}
	default:
		// A read-only transaction is a deferred BEGIN; the others take the write lock when they start.
		begin := "BEGIN IMMEDIATE"
		if o.readOnly {
			begin = "BEGIN"
		}
		steps = append(steps, opening{KindBegin, begin})
	}
	began := false
	for _, step := range steps {
		if _, err := t.machinery().exec(ctx, step.kind, nil, step.sql); err != nil {
			if began {
				return nil, t.rollbackAfter(err)
			}
			t.finished.Store(true)
			cancel()
			return nil, errors.Join(err, t.closeSession(), conn.Close())
		}
		if step.kind == KindBegin {
			began = true
		}
	}
	if d.driver == "sqlite" {
		if err := t.beginSQLiteMode(); err != nil {
			return nil, t.rollbackAfter(err)
		}
	}
	return t, nil
}

// rollback restores the SQLite mode, releases named locks, resets local values, and native
// rolls back, attempting all of them and returning every failure. If the transaction's context
// was canceled, a statement cannot run with that context, so the connection is closed.
// A connection returned to the pool is either clean or discarded: if any cleanup or rollback
// failed (including a rollback after a failed cleanup that preceded a failed commit), the session state
// is unknown, so the connection is closed rather than returned to the pool (closeSession).
func (t *txConn) rollback() error {
	if t.finished.Load() {
		return nil
	}
	if t.md != nil {
		return t.endMarkdown("rollback")
	}
	if t.ctx.Err() != nil {
		if t.db.driver != "sqlite" {
			t.finished.Store(true)
			t.closeStatements()
			err := t.closeSession()
			t.cancel()
			return err
		}
		// SQLite connections can still be used after a canceled statement, so for a canceled context the connection
		// restores the mode with a context that is not canceled, and then runs ROLLBACK.
		t.ctx = context.WithoutCancel(t.ctx)
	}
	errs := []error{t.finishSQLiteMode(), t.releaseLocks(), t.clearLocals()}
	t.finished.Store(true)
	t.closeStatements()
	errs = append(errs, t.rollbackNative())
	if t.unclean || errors.Join(errs...) != nil {
		errs = append(errs, t.closeSession())
	}
	errs = append(errs, t.conn.Close())
	t.cancel()
	return errors.Join(errs...)
}

// closeSession closes the transaction connection without returning it to the pool. For a canceled
// transaction, database/sql rolls back, but for a driver that implements driver.SessionResetter and
// driver.Validator (go-sql-driver), the connection stays in the pool and passes its named
// lock, user variables, and SQLite mode on to the next user. The session of a closed connection
// is ended by the server together with the transaction and its state. A connection that database/sql
// already closed is sql.ErrConnDone.
func (t *txConn) closeSession() error {
	err := t.conn.Raw(func(any) error { return driver.ErrBadConn })
	if errors.Is(err, driver.ErrBadConn) || errors.Is(err, sql.ErrConnDone) {
		return nil
	}
	return err
}

// rollbackNative rolls back the native transaction. If the transaction's context
// was canceled, database/sql has already rolled back, so sql.ErrTxDone is not a failure.
// Other failures, including a failed rollback after the driver or server closed the connection, are reported
// as failures (docs/interfaces.md).
// commitNative commits the transaction.
func (t *txConn) commitNative() error {
	_, err := t.run().exec(t.ctx, KindCommit, nil, "COMMIT")
	return err
}

func (t *txConn) rollbackNative() error {
	_, err := t.run().exec(t.ctx, KindRollback, nil, "ROLLBACK")
	return err
}

func (t *txConn) commit() error {
	if t.finished.Load() {
		return configErr("transaction already finished")
	}
	// A cancelled context (the handle's, or the transaction timeout) has
	// already rolled the transaction back under database/sql.
	if err := t.ctx.Err(); err != nil {
		return t.rollbackAfter(&ir.Error{Code: CodeCanceled, Msg: err.Error()})
	}
	if t.md != nil {
		return t.endMarkdown("commit")
	}
	if err := t.finishSQLiteMode(); err != nil {
		t.unclean = true
		return t.rollbackAfter(err)
	}
	if err := t.releaseLocks(); err != nil {
		t.unclean = true
		return t.rollbackAfter(err)
	}
	if err := t.clearLocals(); err != nil {
		t.unclean = true
		return t.rollbackAfter(err)
	}
	t.closeStatements()
	err := t.commitNative()
	if err != nil {
		// After a failed COMMIT the session state is unknown, so the connection is discarded.
		err = errors.Join(err, t.closeSession())
	}
	if closeErr := t.conn.Close(); closeErr != nil {
		err = errors.Join(err, closeErr)
	}
	t.finished.Store(true)
	t.cancel()
	return err
}

// savepoint runs fn inside a savepoint of the active transaction.
func (t *txConn) savepoint(fn func() error) (err error) {
	insertedBefore := cloneInserted(t.inserted)
	t.savepoints++
	name := fmt.Sprintf("orm_sp_%d", t.savepoints)
	defer func() { t.savepoints-- }()
	if t.md != nil {
		if err := t.savepointMarkdown("savepoint", name); err != nil {
			return err
		}
	} else if _, err := t.run().exec(t.ctx, KindSavepoint, nil, "SAVEPOINT "+name); err != nil {
		return err
	}
	pushFrame(t)
	returned := false
	defer func() {
		popFrame()
		// If a callback leaves without returning, no caller receives an error, so the failed
		// savepoint rollback is reported as a panic.
		if r := recover(); r != nil {
			t.inserted = insertedBefore
			if rollbackErr := t.rollbackSavepoint(name); rollbackErr != nil {
				panic(rollbackFailed(r, rollbackErr))
			}
			panic(r)
		}
		if !returned {
			t.inserted = insertedBefore
			if rollbackErr := t.rollbackSavepoint(name); rollbackErr != nil {
				panic(rollbackFailed("callback exited without returning", rollbackErr))
			}
		}
	}()
	err = fn()
	returned = true
	if err != nil {
		t.inserted = insertedBefore
		if rollbackErr := t.rollbackSavepoint(name); rollbackErr != nil {
			return rollbackFailed(err, rollbackErr)
		}
		return err
	}
	return t.endSavepoint(KindRelease, name)
}

// rollbackSavepoint undoes the work after the savepoint and releases the savepoint. It
// attempts both statements and returns every failure.
func (t *txConn) rollbackSavepoint(name string) error {
	return errors.Join(t.endSavepoint(KindRollbackTo, name), t.endSavepoint(KindRelease, name))
}

// endSavepoint ends the savepoint name: it releases it if kind is KindRelease, and if kind is KindRollbackTo,
// it undoes the work after it. A SQL connection sends that statement; a markdown connection sends a control
// message of the same name. If the transaction's context is canceled, database/sql (for markdown,
// the server of the closed connection) rolled back the whole transaction, so the savepoint also ended and this is not a failure. Other
// failures are reported.
func (t *txConn) endSavepoint(kind, name string) error {
	var err error
	if t.md != nil {
		err = t.savepointMarkdown(kind, name)
	} else {
		statement := "RELEASE SAVEPOINT " + name
		if kind == KindRollbackTo {
			statement = "ROLLBACK TO SAVEPOINT " + name
		}
		_, err = t.run().exec(t.ctx, kind, nil, statement)
	}
	if err == nil || t.ctx.Err() != nil && ErrorCode(err) != CodeSubscriber {
		return nil
	}
	return err
}

func cloneInserted(src map[string]map[int64]struct{}) map[string]map[int64]struct{} {
	if len(src) == 0 {
		return nil
	}
	dst := make(map[string]map[int64]struct{}, len(src))
	for entity, keys := range src {
		copied := make(map[int64]struct{}, len(keys))
		for key := range keys {
			copied[key] = struct{}{}
		}
		dst[entity] = copied
	}
	return dst
}

func (t *txConn) recordInserted(entity string, key int64) {
	if entity == "" || key <= 0 {
		return
	}
	if t.inserted == nil {
		t.inserted = make(map[string]map[int64]struct{})
	}
	if t.inserted[entity] == nil {
		t.inserted[entity] = make(map[int64]struct{})
	}
	t.inserted[entity][key] = struct{}{}
}

// beginSQLiteMode marks the mode before the first PRAGMA, so that even a partly applied mode is
// reverted by finishSQLiteMode.
func (t *txConn) beginSQLiteMode() error {
	t.sqliteMode = t.isolation == ReadUncommitted || t.readOnly
	if t.isolation == ReadUncommitted {
		if _, err := t.machinery().exec(t.ctx, KindUtility, nil, "PRAGMA read_uncommitted = 1"); err != nil {
			return err
		}
	}
	if t.readOnly {
		if _, err := t.machinery().exec(t.ctx, KindUtility, nil, "PRAGMA query_only = 1"); err != nil {
			return err
		}
	}
	return nil
}

// finishSQLiteMode reverts the SQLite mode changed inside the transaction. The PRAGMA
// value remains on the connection after the transaction, so it returns every failure. It
// does not revert again a mode it attempted once.
func (t *txConn) finishSQLiteMode() error {
	if !t.sqliteMode {
		return nil
	}
	t.sqliteMode = false
	var errs []error
	if t.readOnly {
		if _, err := t.machinery().exec(t.ctx, KindUtility, nil, "PRAGMA query_only = 0"); err != nil {
			errs = append(errs, err)
		}
	}
	if t.isolation == ReadUncommitted {
		if _, err := t.machinery().exec(t.ctx, KindUtility, nil, "PRAGMA read_uncommitted = 0"); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
