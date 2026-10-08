//go:build ormtest

package orm_test

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

var errRollbackFaultCallback = errors.New("rollback fault callback failed")

// rollbackFault는 test entry point의 rollback fault를 설정한다. commit된
// transaction은 fault를 남기고, callback이 실패한 다음 transaction은 rollback되며
// 그 rollback은 FAULT를 보고하고 transaction은 callback 오류와 fault를 가진
// ROLLBACK을 반환한다. fault는 소비된다: 그 뒤 transaction은 callback 오류만
// 반환하고 connection은 이후 요청을 처리한다.
func rollbackFault(t *testing.T, driver string) {
	db, model, _ := rollbackFixture(t, driver)
	orm.FailNextRollback(db)
	if err := db.Transaction(func() error { return probeCreate(model, "committed") }, orm.Retry(0)); err != nil {
		t.Fatalf("a committed transaction with an armed fault: %v", err)
	}
	err := db.Transaction(func() error {
		if err := probeCreate(model, "rolled back"); err != nil {
			return err
		}
		return errRollbackFaultCallback
	}, orm.Retry(0))
	var coded *orm.Error
	if !errors.As(err, &coded) || coded.Code != orm.CodeRollback {
		t.Fatalf("transaction = %v, want ROLLBACK", err)
	}
	joined, ok := coded.Cause.(interface{ Unwrap() []error })
	if !ok || len(joined.Unwrap()) != 2 {
		t.Fatalf("ROLLBACK does not keep the callback and rollback errors: %#v", coded.Cause)
	}
	if joined.Unwrap()[0] != errRollbackFaultCallback {
		t.Fatalf("callback error = %v, want the error of the callback", joined.Unwrap()[0])
	}
	var fault *orm.Error
	if !errors.As(joined.Unwrap()[1], &fault) || fault.Code != orm.CodeFault {
		t.Fatalf("rollback error = %v, want FAULT", joined.Unwrap()[1])
	}
	if n, err := model().GetCount(); err != nil || n != 1 {
		t.Fatalf("after the faulted rollback: %d rows, %v; want the committed row only", n, err)
	}
	err = db.Transaction(func() error {
		if err := probeCreate(model, "rolled back"); err != nil {
			return err
		}
		return errRollbackFaultCallback
	}, orm.Retry(0))
	if err != errRollbackFaultCallback {
		t.Fatalf("the transaction after the consumed fault = %v, want the callback error", err)
	}
	if n, err := model().GetCount(); err != nil || n != 1 {
		t.Fatalf("after the second rollback: %d rows, %v; want the committed row only", n, err)
	}
}

func TestRollbackFaultSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	rollbackFault(t, "sqlite")
}
func TestRollbackFaultMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	rollbackFault(t, "mysql")
}
func TestRollbackFaultPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	rollbackFault(t, "postgres")
}
