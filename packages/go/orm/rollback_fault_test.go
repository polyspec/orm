//go:build ormtest

package orm_test

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

var errRollbackFaultCallback = errors.New("rollback fault callback failed")

// rollbackFault sets the test entry point's rollback fault. A transaction that committed
// keeps the fault, and the next transaction whose callback failed is rolled back, and that
// rollback reports FAULT, so the transaction returns the ROLLBACK with both the callback error and the fault.
// The fault is consumed: after that, the transaction returns only the callback error
// and the connection serves later requests.
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
