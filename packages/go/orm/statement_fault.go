package orm

import (
	"github.com/polyspec/orm/packages/go/engine/ir"
)

// stmtFault는 FailNextStatement이 설정한 code와 message다.
type stmtFault struct {
	code string
	msg  string
}

// fault는 kind의 statement를 보내기 전에 설정된 statement fault를 확인한다. transaction
// machinery와 transaction control statement는 fault를 소비하지 않는다
// (docs/protocol.md 3.2). 그 밖의 statement는 설정된 fault가 있으면 fault를 소비하고
// 그 오류를 돌려주며, 이때 database에는 보내지 않는다.
func (r runner) fault(kind string) error {
	if r.machinery || isTransactionControl(kind) {
		return nil
	}
	return r.d.takeStatementFault()
}

// takeStatementFault는 설정된 statement fault를 소비하고 그 오류를 돌려준다. fault가
// 없으면 nil이다. model statement의 경로도 이 함수로 fault를 소비한다.
func (d *DB) takeStatementFault() error {
	f := d.m.statementFault.Swap(nil)
	if f == nil {
		return nil
	}
	return &ir.Error{Code: f.code, Msg: f.msg}
}

// isTransactionControl은 transaction을 시작, 끝, 중첩하는 statement의 kind인지 확인한다.
func isTransactionControl(kind string) bool {
	switch kind {
	case KindBegin, KindCommit, KindRollback, KindSavepoint, KindRelease, KindRollbackTo:
		return true
	}
	return false
}
