package orm

import (
	"github.com/polyspec/orm/packages/go/engine/ir"
)

// stmtFault is the code and message that FailNextStatement set.
type stmtFault struct {
	code string
	msg  string
}

// fault checks the statement fault set before sending a statement of the kind. Transaction
// machinery and transaction control statements do not consume the fault
// (docs/spec/protocol.md 3.2). For other statements, if a fault is set, it is consumed
// and its error is returned, and in that case nothing is sent to the database.
func (r runner) fault(kind string) error {
	if r.machinery || isTransactionControl(kind) {
		return nil
	}
	return r.d.takeStatementFault()
}

// takeStatementFault consumes the set statement fault and returns its error. If there is no
// fault, it is nil. The model statement path also consumes the fault through this function.
func (d *DB) takeStatementFault() error {
	f := d.m.statementFault.Swap(nil)
	if f == nil {
		return nil
	}
	return &ir.Error{Code: f.code, Msg: f.msg}
}

// isTransactionControl checks whether the kind is a statement that starts, ends, or nests a transaction.
func isTransactionControl(kind string) bool {
	switch kind {
	case KindBegin, KindCommit, KindRollback, KindSavepoint, KindRelease, KindRollbackTo:
		return true
	}
	return false
}
