package orm

import (
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
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
// database (docs/operations/usage.md, statement events).
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

// subscription is one registered subscriber. It is found by pointer when unsubscribed.
type subscription struct{ fn Subscriber }

// subscribers is the subscriber list shared by all handles of the connection. The list
// is rebuilt whenever it changes, so publish uses the list it reads without a lock.
type subscribers struct {
	mu   sync.Mutex
	list atomic.Pointer[[]*subscription]
	// txSeq is the connection's outer transaction number. It goes up by one on every begin.
	txSeq int64
}

// Subscribe registers fn for the statement events of the connection and of
// every handle derived from it. Subscribers run in registration order. The
// returned function removes the subscription. A markdown connection sends no
// statement, so it refuses a subscriber with CAPABILITY_UNSUPPORTED.
func (d *DB) Subscribe(fn Subscriber) (unsubscribe func(), err error) {
	if err := d.unsupportedOnMarkdown("statement events"); err != nil {
		return nil, err
	}
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
	}, nil
}

// nextTransaction is the number of the new outer transaction.
func (d *DB) nextTransaction() int64 {
	d.m.subs.mu.Lock()
	defer d.m.subs.mu.Unlock()
	d.m.subs.txSeq++
	return d.m.subs.txSeq
}

// statementDone publishes the event of a finished statement and returns the error
// that the operation receives: SUBSCRIBER if a subscriber fails, otherwise the statement's error.
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

// statementKind is the kind of the statement the planner wrote: the first word of the SQL. ALTER
// is the schema statement of a MySQL identity restart.
func statementKind(sqlText string) string {
	verb, _, _ := strings.Cut(strings.TrimSpace(sqlText), " ")
	switch strings.ToUpper(verb) {
	case "ALTER":
		return KindSchema
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
