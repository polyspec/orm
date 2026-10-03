package orm

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
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
	db *DB
	// conn은 transaction이 끝날 때까지 잡아 두는 pool connection이다. rollback이
	// 실패하면 driver가 그 connection을 닫았는지 확인한다.
	conn       *sql.Conn
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
	// operation은 이 transaction(unit of work)의 operation id다. audit table의
	// insert와 update가 operation column에 쓴다. 없으면 nil이다.
	operation any
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
	operation any
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

// Operation은 transaction을 operation id의 unit of work로 만든다. audit table에
// 대한 transaction 안의 모든 insert와 update는 이 id를 table의 operation
// column에 쓴다. id는 i64 operation column이면 int64, uuid column이면
// 소문자 UUID string이다. nested transaction은 바깥 transaction의 id를 쓴다.
func Operation(id any) TransactionOption {
	return func(o *txOptions) { o.operation, o.set = id, true }
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
	switch o.operation.(type) {
	case nil, int64, string:
	default:
		return configErr("operation id is %T; an operation id is an int64 or a UUID string", o.operation)
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
		// callback이 반환하지 않고 떠나면 오류를 받을 호출자가 없으므로 실패한
		// rollback은 panic으로 보고한다.
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

// rollbackFailed는 transaction이나 savepoint를 끝낸 원인과 실패한 rollback을
// 하나의 ROLLBACK 오류로 보고한다 (docs/errors.yaml, docs/interfaces.md). 오류의
// Cause는 원인과 rollback 오류의 errors.Join이므로 errors.Is와 errors.As가 둘을
// 모두 찾는다. panic 값처럼 error가 아닌 원인은 그 text의 error가 된다.
func rollbackFailed(cause any, rollbackErr error) error {
	causeErr, ok := cause.(error)
	if !ok {
		causeErr = errors.New(fmt.Sprint(cause))
	}
	return &ir.Error{Code: CodeRollback, Msg: fmt.Sprintf("transaction failed (%v) and rollback failed (%v)", causeErr, rollbackErr), Cause: errors.Join(causeErr, rollbackErr)}
}

// rollbackAfter는 cause로 끝나는 transaction을 rollback하고 cause를 돌려준다.
// rollback도 실패하면 두 오류를 함께 돌려준다.
func (t *txConn) rollbackAfter(cause error) error {
	if rollbackErr := t.rollback(); rollbackErr != nil {
		return rollbackFailed(cause, rollbackErr)
	}
	return cause
}

// rollbackFaultErr는 설정된 test fault가 rollback이 실행된 뒤 보고하는 rollback
// 오류다 (FailNextRollback, build tag ormtest).
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
	conn, err := d.sql.Conn(ctx)
	if err != nil {
		cancel()
		return nil, mapDriverErr(err)
	}
	native, err := conn.BeginTx(ctx, txo)
	if err != nil {
		cancel()
		if closeErr := conn.Close(); closeErr != nil {
			return nil, errors.Join(mapDriverErr(err), closeErr)
		}
		return nil, mapDriverErr(err)
	}
	t := &txConn{db: d, conn: conn, tx: native, ctx: ctx, cancel: cancel, readOnly: o.readOnly, isolation: o.isolation, operation: o.operation}
	if o.timeoutMs > 0 {
		if _, err := native.ExecContext(ctx, fmt.Sprintf("SET LOCAL statement_timeout = %d", o.timeoutMs)); err != nil {
			return nil, t.rollbackAfter(mapDriverErr(err))
		}
	}
	if d.driver == "sqlite" {
		if err := t.beginSQLiteMode(); err != nil {
			return nil, t.rollbackAfter(err)
		}
	}
	return t, nil
}

// rollback은 SQLite mode 복원, named lock 해제, local 값 reset, native
// rollback을 모두 시도하고 실패한 것을 모두 돌려준다. transaction의 context가
// 취소되었으면 그 context로 statement를 실행할 수 없으므로 connection을 닫는다.
func (t *txConn) rollback() error {
	if t.finished.Load() {
		return nil
	}
	if t.ctx.Err() != nil {
		t.finished.Store(true)
		t.closeStatements()
		err := t.closeSession()
		t.cancel()
		return err
	}
	errs := []error{t.finishSQLiteMode(), t.releaseLocks(), t.clearLocals()}
	t.finished.Store(true)
	t.closeStatements()
	errs = append(errs, t.rollbackNative(), t.conn.Close())
	t.cancel()
	return errors.Join(errs...)
}

// closeSession은 transaction connection을 pool에 돌려주지 않고 닫는다. 취소된
// transaction은 database/sql이 rollback하지만, driver.SessionResetter와
// driver.Validator를 구현한 driver(go-sql-driver)의 connection은 pool에 남아 named
// lock, user variable, SQLite mode를 다음 사용자에게 넘긴다. 닫힌 connection의
// session은 server가 transaction과 그 상태와 함께 끝낸다. database/sql이 이미 닫은
// connection은 sql.ErrConnDone이다.
func (t *txConn) closeSession() error {
	err := t.conn.Raw(func(any) error { return driver.ErrBadConn })
	if errors.Is(err, driver.ErrBadConn) || errors.Is(err, sql.ErrConnDone) {
		return nil
	}
	return err
}

// rollbackNative는 native transaction을 rollback한다. transaction의 context가
// 취소되면 database/sql이 이미 rollback했으므로 sql.ErrTxDone은 실패가 아니다.
// 그 밖의 실패는, driver나 server가 connection을 닫아 실패한 rollback도, 실패로
// 보고한다 (docs/interfaces.md).
func (t *txConn) rollbackNative() error {
	err := t.tx.Rollback()
	if err == nil || errors.Is(err, sql.ErrTxDone) && t.ctx.Err() != nil {
		return nil
	}
	return mapDriverErr(err)
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
	if err := t.finishSQLiteMode(); err != nil {
		return t.rollbackAfter(err)
	}
	if err := t.releaseLocks(); err != nil {
		return t.rollbackAfter(err)
	}
	if err := t.clearLocals(); err != nil {
		return t.rollbackAfter(err)
	}
	t.closeStatements()
	err := mapDriverErr(t.tx.Commit())
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
	// savepoint 안에서 정한 operation id는 그 작업과 함께 되돌린다.
	operationBefore := t.operation
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
		// callback이 반환하지 않고 떠나면 오류를 받을 호출자가 없으므로 실패한
		// savepoint rollback은 panic으로 보고한다.
		if r := recover(); r != nil {
			t.inserted, t.operation = insertedBefore, operationBefore
			if rollbackErr := t.rollbackSavepoint(name); rollbackErr != nil {
				panic(rollbackFailed(r, rollbackErr))
			}
			panic(r)
		}
		if !returned {
			t.inserted, t.operation = insertedBefore, operationBefore
			if rollbackErr := t.rollbackSavepoint(name); rollbackErr != nil {
				panic(rollbackFailed("callback exited without returning", rollbackErr))
			}
		}
	}()
	err = fn()
	returned = true
	if err != nil {
		t.inserted, t.operation = insertedBefore, operationBefore
		if rollbackErr := t.rollbackSavepoint(name); rollbackErr != nil {
			return rollbackFailed(err, rollbackErr)
		}
		return err
	}
	return t.endSavepoint("RELEASE SAVEPOINT " + name)
}

// rollbackSavepoint는 savepoint 뒤의 작업을 되돌리고 savepoint를 푼다. 두
// statement를 모두 시도하고 실패를 모두 돌려준다.
func (t *txConn) rollbackSavepoint(name string) error {
	return errors.Join(t.endSavepoint("ROLLBACK TO SAVEPOINT "+name), t.endSavepoint("RELEASE SAVEPOINT "+name))
}

// endSavepoint는 savepoint를 끝내는 statement를 실행한다. transaction의
// context가 취소되면 database/sql이 transaction 전체를 rollback했으므로
// savepoint도 함께 끝났고 실패가 아니다. 그 밖의 실패는 보고한다.
func (t *txConn) endSavepoint(statement string) error {
	_, err := t.tx.ExecContext(t.ctx, statement)
	if err == nil || t.ctx.Err() != nil {
		return nil
	}
	return mapDriverErr(err)
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

// beginSQLiteMode는 첫 PRAGMA 전에 mode를 표시하므로 일부만 적용된 mode도
// finishSQLiteMode가 되돌린다.
func (t *txConn) beginSQLiteMode() error {
	t.sqliteMode = t.isolation == ReadUncommitted || t.readOnly
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
	return nil
}

// finishSQLiteMode는 transaction 안에서 바꾼 SQLite mode를 되돌린다. PRAGMA
// 값은 transaction 뒤에도 connection에 남으므로 실패를 모두 돌려준다. 한 번
// 시도한 mode는 다시 되돌리지 않는다.
func (t *txConn) finishSQLiteMode() error {
	if !t.sqliteMode {
		return nil
	}
	t.sqliteMode = false
	var errs []error
	if t.readOnly {
		if _, err := t.tx.ExecContext(t.ctx, "PRAGMA query_only = 0"); err != nil {
			errs = append(errs, mapDriverErr(err))
		}
	}
	if t.isolation == ReadUncommitted {
		if _, err := t.tx.ExecContext(t.ctx, "PRAGMA read_uncommitted = 0"); err != nil {
			errs = append(errs, mapDriverErr(err))
		}
	}
	return errors.Join(errs...)
}
