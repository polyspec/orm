package orm

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"math/rand/v2"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/polyspec/orm/engine/ir"
)

// executor is where a statement runs: a connection or an active transaction.
type executor interface {
	base() *DB
	context() context.Context
	stmt(ctx context.Context, sqlText string) (*sql.Stmt, error)
	exec(ctx context.Context, sqlText string, args ...any) (sql.Result, error)
	transaction() *txConn
	// enter marks the start of a statement and returns its end; a
	// transaction rejects concurrent use.
	enter() (func(), error)
}

func (d *DB) base() *DB                { return d }
func (d *DB) context() context.Context { return d.ctx }
func (d *DB) transaction() *txConn     { return nil }
func (d *DB) enter() (func(), error) {
	if d.m.closed.Load() {
		return nil, configErr("database is closed")
	}
	return func() {}, nil
}
func (d *DB) exec(ctx context.Context, sqlText string, args ...any) (sql.Result, error) {
	r, err := d.sql.ExecContext(ctx, sqlText, args...)
	return r, mapDriverErr(err)
}

// txConn is one active transaction.
type txConn struct {
	db         *DB
	tx         *sql.Tx
	ctx        context.Context
	cancel     context.CancelFunc
	busy       atomic.Bool
	finished   atomic.Bool
	savepoints int
	stmMu      sync.Mutex
	stmts      map[string]*sql.Stmt
	locals     map[string]string
	locks      []string
	readOnly   bool
	isolation  IsolationLevel
	sqliteMode bool
	contextRow bool
	// inserted records generated ORM inserts that succeeded in this
	// transaction. It is an adapter-neutral transaction fact used by callers
	// that must distinguish a row created in this transaction from a matching
	// row committed earlier.
	inserted map[string]map[int64]struct{}
}

func (t *txConn) base() *DB                { return t.db }
func (t *txConn) context() context.Context { return t.ctx }
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
	st, err := t.tx.PrepareContext(ctx, sqlText)
	if err != nil {
		return nil, mapDriverErr(err)
	}
	if t.stmts == nil {
		t.stmts = map[string]*sql.Stmt{}
	}
	t.stmts[sqlText] = st
	return st, nil
}

func (t *txConn) exec(ctx context.Context, sqlText string, args ...any) (sql.Result, error) {
	r, err := t.tx.ExecContext(ctx, sqlText, args...)
	return r, mapDriverErr(err)
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
type txContext struct {
	*txConn
	ctx context.Context
}

func (t txContext) context() context.Context { return t.ctx }

func resolve(conn *DB) (executor, error) {
	if conn != nil {
		if t := activeFor(conn); t != nil {
			if conn.ctx != t.ctx && conn.ctx != nil {
				return txContext{txConn: t, ctx: conn.ctx}, nil
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
	set       bool
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
		if r := recover(); r != nil {
			t.rollback()
			panic(r)
		}
		if !returned {
			t.rollback()
		}
	}()
	err = fn()
	returned = true
	if err != nil {
		t.rollback()
		return err
	}
	return t.commit()
}

func (d *DB) begin(o txOptions) (*txConn, error) {
	if d.m.closed.Load() {
		return nil, configErr("database is closed")
	}
	if o.timeoutMs > 0 && d.driver != "postgres" {
		return nil, &ir.Error{Code: CodeCapabilityUnsupported, Msg: "transaction timeoutMs is supported only by postgres"}
	}
	level := sql.LevelDefault
	switch o.isolation {
	case "":
	case ReadUncommitted:
		level = sql.LevelReadUncommitted
	case ReadCommitted:
		level = sql.LevelReadCommitted
	case RepeatableRead:
		level = sql.LevelRepeatableRead
	case Serializable:
		level = sql.LevelSerializable
	default:
		return nil, configErr("unsupported transaction isolation %q", o.isolation)
	}
	txo := &sql.TxOptions{Isolation: level, ReadOnly: o.readOnly}
	if d.driver == "sqlite" {
		// The ORM applies the isolation and read-only modes on the
		// transaction connection. The read-only flag selects a deferred
		// BEGIN; every other transaction begins with the DSN's
		// _txlock=immediate and holds the write lock from its start.
		txo = &sql.TxOptions{ReadOnly: o.readOnly}
		if err := ensureSQLiteRowLock(d.ctx, d); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithCancel(d.ctx)
	native, err := d.sql.BeginTx(ctx, txo)
	if err != nil {
		cancel()
		return nil, mapDriverErr(err)
	}
	t := &txConn{db: d, tx: native, ctx: ctx, cancel: cancel, readOnly: o.readOnly, isolation: o.isolation}
	if o.timeoutMs > 0 {
		if _, err := native.ExecContext(ctx, fmt.Sprintf("SET LOCAL statement_timeout = %d", o.timeoutMs)); err != nil {
			t.abort()
			return nil, mapDriverErr(err)
		}
	}
	if d.driver == "sqlite" {
		if err := t.beginSQLiteMode(); err != nil {
			t.abort()
			return nil, err
		}
	}
	return t, nil
}

func (t *txConn) abort() {
	if !t.finished.Load() {
		t.releaseLocks()
		t.clearLocals()
	}
	t.finished.Store(true)
	t.closeStatements()
	_ = t.tx.Rollback()
	t.cancel()
}

func (t *txConn) rollback() {
	if t.finished.Load() {
		return
	}
	_ = t.finishSQLiteMode()
	t.abort()
}

func (t *txConn) commit() error {
	if t.finished.Load() {
		return configErr("transaction already finished")
	}
	// A cancelled context (the handle's, or the transaction timeout) has
	// already rolled the transaction back under database/sql.
	if err := t.ctx.Err(); err != nil {
		t.abort()
		return &ir.Error{Code: CodeCanceled, Msg: err.Error()}
	}
	if t.contextRow {
		if _, err := t.tx.ExecContext(t.ctx, "DELETE FROM orm__context"); err != nil {
			t.abort()
			return mapDriverErr(err)
		}
	}
	if err := t.finishSQLiteMode(); err != nil {
		t.abort()
		return err
	}
	t.releaseLocks()
	t.clearLocals()
	t.closeStatements()
	err := mapDriverErr(t.tx.Commit())
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
	if _, err := t.tx.ExecContext(t.ctx, "SAVEPOINT "+name); err != nil {
		return mapDriverErr(err)
	}
	pushFrame(t)
	returned := false
	defer func() {
		popFrame()
		if r := recover(); r != nil {
			t.inserted = insertedBefore
			_, _ = t.tx.ExecContext(t.ctx, "ROLLBACK TO SAVEPOINT "+name)
			panic(r)
		}
		if !returned {
			t.inserted = insertedBefore
			_, _ = t.tx.ExecContext(t.ctx, "ROLLBACK TO SAVEPOINT "+name)
			_, _ = t.tx.ExecContext(t.ctx, "RELEASE SAVEPOINT "+name)
		}
	}()
	err = fn()
	returned = true
	if err != nil {
		t.inserted = insertedBefore
		if _, rbErr := t.tx.ExecContext(t.ctx, "ROLLBACK TO SAVEPOINT "+name); rbErr != nil {
			return mapDriverErr(rbErr)
		}
		_, _ = t.tx.ExecContext(t.ctx, "RELEASE SAVEPOINT "+name)
		return err
	}
	if _, err := t.tx.ExecContext(t.ctx, "RELEASE SAVEPOINT "+name); err != nil {
		return mapDriverErr(err)
	}
	return nil
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

func (t *txConn) beginSQLiteMode() error {
	if t.isolation == ReadUncommitted {
		if _, err := t.tx.ExecContext(t.ctx, "PRAGMA read_uncommitted = 1"); err != nil {
			return mapDriverErr(err)
		}
	}
	if t.readOnly {
		if _, err := t.tx.ExecContext(t.ctx, "PRAGMA query_only = 1"); err != nil {
			return mapDriverErr(err)
		}
	}
	t.sqliteMode = t.isolation == ReadUncommitted || t.readOnly
	return nil
}

func (t *txConn) finishSQLiteMode() error {
	if !t.sqliteMode {
		return nil
	}
	if t.readOnly {
		if _, err := t.tx.ExecContext(t.ctx, "PRAGMA query_only = 0"); err != nil {
			return mapDriverErr(err)
		}
	}
	if t.isolation == ReadUncommitted {
		if _, err := t.tx.ExecContext(t.ctx, "PRAGMA read_uncommitted = 0"); err != nil {
			return mapDriverErr(err)
		}
	}
	t.sqliteMode = false
	return nil
}
