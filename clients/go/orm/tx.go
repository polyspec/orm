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

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/runtimemodel"
)

// executor is where a statement runs: a connection or an active transaction.
type executor interface {
	base() *DB
	context() context.Context
	stmt(ctx context.Context, sqlText string) (modelStatement, error)
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

// txConn is one active transaction.
type txConn struct {
	db *DB
	// conn은 transaction이 끝날 때까지 잡아 두는 pool connection이다. rollback이
	// 실패하면 driver가 그 connection을 닫았는지 확인한다.
	conn *sql.Conn
	// number는 연결에서 이 transaction의 번호다. statement event가 싣는다.
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
	readOnly   bool
	isolation  IsolationLevel
	sqliteMode bool
	// audit은 이 transaction(unit of work)이 시작할 때 삽입한 audit 기록이다.
	// audit table의 insert와 update가 그 key를 audit column에 쓴다. 없으면
	// nil이다.
	audit *auditRecord
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
// the transaction ends. A PostgreSQL statement is not prepared (unprepared).
func (t *txConn) stmt(ctx context.Context, sqlText string) (modelStatement, error) {
	if t.db.driver == "postgres" {
		return unprepared{q: t.conn, sql: sqlText}, nil
	}
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

// run은 transaction 연결에서 statement를 보내고 그 event를 publish한다.
func (t *txConn) run() runner { return runner{d: t.db, q: t.conn, tx: t.number} }

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
	audit     map[string]any
	auditSet  bool
	set       bool
}

// auditRecord는 transaction이 삽입한 audit 기록의 table과 primary key 값이다.
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

// auditInsert는 transaction이 삽입할 audit 기록이다: 기록 table의 entity와 그
// entity가 속한 schema, column 값이다.
type auditInsert struct {
	schema *Schema
	ent    *runtimemodel.Entity
	values map[string]any
}

// auditRecord는 audit source의 값에 transaction의 값을 더한 audit 기록이다.
// 같은 column이면 transaction의 값이 이긴다. 기록 table은 연결에 등록한 set의
// audit setting이 references로 이름한 table 하나이며, 그 table을 entity로 가진
// set이 연결에 등록되어 있어야 한다. audit source가 없거나, 기록 table이 없거나
// 여럿이거나, 값의 key가 그 table의 column이 아니거나, primary key가 column
// 하나가 아니면 CONFIG이고, source의 오류는 그대로 돌려준다.
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
				if e := eng.M.Entities[name]; e.Table == tables[0] {
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

// insertAudit은 transaction의 audit 기록을 삽입하고 그 table과 primary key
// 값을 돌려준다. primary key가 identity이면 생성된 key, 아니면 기록의 값이다.
// 시도마다 다시 삽입한다.
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
		// SQLite의 row lock table은 연결의 첫 transaction 전에 한 번 만든다.
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
	// transaction을 여는 statement다(docs/usage.md "Statement events"). 하나라도
	// 실패하면 session에 남은 설정이 다음 사용자에게 가지 않도록 연결을 닫는다.
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
		// 읽기 전용 transaction은 deferred BEGIN이고, 나머지는 시작할 때 쓰기 lock을 잡는다.
		begin := "BEGIN IMMEDIATE"
		if o.readOnly {
			begin = "BEGIN"
		}
		steps = append(steps, opening{KindBegin, begin})
	}
	began := false
	for _, step := range steps {
		if _, err := t.run().exec(ctx, step.kind, nil, step.sql); err != nil {
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

// rollback은 SQLite mode 복원, named lock 해제, local 값 reset, native
// rollback을 모두 시도하고 실패한 것을 모두 돌려준다. transaction의 context가
// 취소되었으면 그 context로 statement를 실행할 수 없으므로 connection을 닫는다.
func (t *txConn) rollback() error {
	if t.finished.Load() {
		return nil
	}
	if t.ctx.Err() != nil {
		if t.db.driver != "sqlite" {
			t.finished.Store(true)
			t.closeStatements()
			err := t.closeSession()
			t.cancel()
			return err
		}
		// SQLite 연결은 취소된 statement 뒤에도 쓸 수 있으므로 취소되지 않는
		// context로 mode를 되돌리고 ROLLBACK한다.
		t.ctx = context.WithoutCancel(t.ctx)
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
// commitNative는 transaction을 commit한다.
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
	err := t.commitNative()
	if err != nil {
		// 실패한 COMMIT 뒤의 session 상태는 알 수 없으므로 연결을 버린다.
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
	if _, err := t.run().exec(t.ctx, KindSavepoint, nil, "SAVEPOINT "+name); err != nil {
		return err
	}
	pushFrame(t)
	returned := false
	defer func() {
		popFrame()
		// callback이 반환하지 않고 떠나면 오류를 받을 호출자가 없으므로 실패한
		// savepoint rollback은 panic으로 보고한다.
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
	return t.endSavepoint(KindRelease, "RELEASE SAVEPOINT "+name)
}

// rollbackSavepoint는 savepoint 뒤의 작업을 되돌리고 savepoint를 푼다. 두
// statement를 모두 시도하고 실패를 모두 돌려준다.
func (t *txConn) rollbackSavepoint(name string) error {
	return errors.Join(t.endSavepoint(KindRollbackTo, "ROLLBACK TO SAVEPOINT "+name), t.endSavepoint(KindRelease, "RELEASE SAVEPOINT "+name))
}

// endSavepoint는 savepoint를 끝내는 statement를 실행한다. transaction의
// context가 취소되면 database/sql이 transaction 전체를 rollback했으므로
// savepoint도 함께 끝났고 실패가 아니다. 그 밖의 실패는 보고한다.
func (t *txConn) endSavepoint(kind, statement string) error {
	_, err := t.run().exec(t.ctx, kind, nil, statement)
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

// beginSQLiteMode는 첫 PRAGMA 전에 mode를 표시하므로 일부만 적용된 mode도
// finishSQLiteMode가 되돌린다.
func (t *txConn) beginSQLiteMode() error {
	t.sqliteMode = t.isolation == ReadUncommitted || t.readOnly
	if t.isolation == ReadUncommitted {
		if _, err := t.run().exec(t.ctx, KindUtility, nil, "PRAGMA read_uncommitted = 1"); err != nil {
			return err
		}
	}
	if t.readOnly {
		if _, err := t.run().exec(t.ctx, KindUtility, nil, "PRAGMA query_only = 1"); err != nil {
			return err
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
		if _, err := t.run().exec(t.ctx, KindUtility, nil, "PRAGMA query_only = 0"); err != nil {
			errs = append(errs, err)
		}
	}
	if t.isolation == ReadUncommitted {
		if _, err := t.run().exec(t.ctx, KindUtility, nil, "PRAGMA read_uncommitted = 0"); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
