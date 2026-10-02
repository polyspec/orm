//go:build ormtest

package orm_test

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
)

var errRollbackFaultCallback = errors.New("rollback fault callback failed")

// rollbackFault arms the rollback fault of the test entry point. A
// committed transaction keeps the fault armed; the next transaction whose
// callback fails is rolled back, its rollback reports FAULT, and the
// transaction returns ROLLBACK with the callback error and the fault. The
// fault is consumed: the transaction after it returns the callback error
// alone, and the connection serves later requests.
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

func TestRollbackFaultSQLite(t *testing.T)   { rollbackFault(t, "sqlite") }
func TestRollbackFaultMySQL(t *testing.T)    { rollbackFault(t, "mysql") }
func TestRollbackFaultPostgres(t *testing.T) { rollbackFault(t, "postgres") }
