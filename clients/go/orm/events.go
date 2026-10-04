package orm

import (
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/polyspec/orm/engine/ir"
)

// Statement kinds of a StatementEvent. The kind comes from the origin of the
// statement: a model statement has the kind of the SQL verb its plan step
// writes, transaction control has its own kinds, schema statements come from
// schema utilities, and every other statement the client sends is utility.
const (
	KindSelect     = "select"
	KindInsert     = "insert"
	KindUpdate     = "update"
	KindDelete     = "delete"
	KindBegin      = "begin"
	KindCommit     = "commit"
	KindRollback   = "rollback"
	KindSavepoint  = "savepoint"
	KindRelease    = "release"
	KindRollbackTo = "rollback_to"
	KindSchema     = "schema"
	KindUtility    = "utility"
)

// StatementEvent describes one statement that the connection sent to the
// database (docs/usage.md, statement events).
type StatementEvent struct {
	SQL string
	// Binds are the bound values; secret and clock slots are replaced by
	// Secret and NowBind.
	Binds []any
	Kind  string
	// Tables are the tables the statement names, sorted; transaction control
	// names none.
	Tables  []string
	Elapsed time.Duration
	// Transaction is the number of the transaction of the connection that
	// the statement ran in, counted from 1 by every outermost begin; zero
	// outside a transaction.
	Transaction int64
	// Err is the error the statement ended with, or nil.
	Err error
}

// Subscriber receives the event of every statement after the statement ends
// and before the operation continues. A subscriber must not fail: an error it
// returns fails the operation with SUBSCRIBER.
type Subscriber func(StatementEvent) error

// subscription은 등록한 subscriber 하나다. 해제할 때 pointer로 찾는다.
type subscription struct{ fn Subscriber }

// subscribers는 연결의 모든 handle이 공유하는 subscriber 목록이다. 목록은
// 바꿀 때마다 새로 만들므로 publish는 lock 없이 읽은 목록을 쓴다.
type subscribers struct {
	mu   sync.Mutex
	list atomic.Pointer[[]*subscription]
	// txSeq는 연결의 바깥 transaction 번호다. begin마다 하나 늘린다.
	txSeq int64
}

// Subscribe registers fn for the statement events of the connection and of
// every handle derived from it. Subscribers run in registration order. The
// returned function removes the subscription.
func (d *DB) Subscribe(fn Subscriber) (unsubscribe func()) {
	s := &subscription{fn: fn}
	d.m.subs.mu.Lock()
	var list []*subscription
	if old := d.m.subs.list.Load(); old != nil {
		list = append(list, *old...)
	}
	list = append(list, s)
	d.m.subs.list.Store(&list)
	d.m.subs.mu.Unlock()
	return func() {
		d.m.subs.mu.Lock()
		defer d.m.subs.mu.Unlock()
		var kept []*subscription
		if old := d.m.subs.list.Load(); old != nil {
			for _, x := range *old {
				if x != s {
					kept = append(kept, x)
				}
			}
		}
		d.m.subs.list.Store(&kept)
	}
}

// nextTransaction은 새 바깥 transaction의 번호다.
func (d *DB) nextTransaction() int64 {
	d.m.subs.mu.Lock()
	defer d.m.subs.mu.Unlock()
	d.m.subs.txSeq++
	return d.m.subs.txSeq
}

// statementDone은 끝난 statement의 event를 publish하고 operation이 받을 오류를
// 돌려준다: subscriber가 실패하면 SUBSCRIBER, 아니면 statement의 오류다.
func (d *DB) statementDone(kind string, tables []string, tx int64, sqlText string, binds []any, start time.Time, err error) error {
	p := d.m.subs.list.Load()
	if p == nil || len(*p) == 0 {
		return err
	}
	list := *p
	if tables == nil {
		tables = []string{}
	}
	if binds == nil {
		binds = []any{}
	}
	e := StatementEvent{SQL: sqlText, Binds: binds, Kind: kind, Tables: tables, Elapsed: time.Since(start), Transaction: tx, Err: err}
	for _, s := range list {
		if serr := s.fn(e); serr != nil {
			return &ir.Error{Code: CodeSubscriber, Msg: "statement event subscriber failed: " + serr.Error(), Cause: serr}
		}
	}
	return err
}

// statementKind는 planner가 쓴 statement의 kind다: SQL의 첫 단어다.
func statementKind(sqlText string) string {
	verb, _, _ := strings.Cut(strings.TrimSpace(sqlText), " ")
	switch strings.ToUpper(verb) {
	case "INSERT":
		return KindInsert
	case "UPDATE":
		return KindUpdate
	case "DELETE":
		return KindDelete
	default:
		return KindSelect
	}
}
