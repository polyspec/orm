package orm

import (
	"errors"
	"fmt"
	"testing"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/testcase"
)

func TestMapMySQLErrClassifiesCheckConstraint(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, number := range []uint16{3819, 4025} {
		err := mapMySQLErr(&mysql.MySQLError{Number: number, Message: "check constraint violated"})
		if got := ErrorCode(err); got != CodeConstraint {
			t.Fatalf("mapped MySQL check error %d = %q, want %q: %v", number, got, CodeConstraint, err)
		}
		if !IsConstraint(err) {
			t.Fatalf("mapped MySQL check error %d is not recognized as a constraint", number)
		}
	}
}

func TestMapMySQLErrClassifiesNowaitLock(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	err := mapMySQLErr(&mysql.MySQLError{Number: 3572, Message: "lock not available"})
	if got := ErrorCode(err); got != CodeLockNotAvailable {
		t.Fatalf("mapped MySQL lock error code = %q, want %q: %v", got, CodeLockNotAvailable, err)
	}
	if !IsLockNotAvailable(err) {
		t.Fatal("mapped MySQL lock error is not recognized as lock unavailable")
	}
}

// TestMapMySQLErrClassifiesLockWaitTimeout checks that a MySQL lock wait timeout (1205, innodb_lock_wait_timeout) is CANCELED,
// the expiry of the write bound of CFG-6, and not DRIVER.
func TestMapMySQLErrClassifiesLockWaitTimeout(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	err := mapMySQLErr(&mysql.MySQLError{Number: 1205, Message: "Lock wait timeout exceeded; try restarting transaction"})
	if got := ErrorCode(err); got != CodeCanceled {
		t.Fatalf("mapped MySQL lock wait timeout 1205 = %q, want %q: %v", got, CodeCanceled, err)
	}
}

func TestMapMySQLErrClassifiesReadOnly(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, number := range []uint16{1290, 1792} {
		err := mapMySQLErr(&mysql.MySQLError{Number: number, Message: "read-only"})
		if got := ErrorCode(err); got != CodeReadOnly {
			t.Fatalf("mapped MySQL read-only error %d = %q, want %q: %v", number, got, CodeReadOnly, err)
		}
	}
}

func TestMapDriverErrorPreservesNativeCause(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	driverErr := &mysql.MySQLError{Number: 1644, Message: "trigger refused the write"}
	mapped := mapDriverErr(driverErr)
	var ormErr *ir.Error
	if !errors.As(mapped, &ormErr) {
		t.Fatalf("mapped error = %T, want *ir.Error", mapped)
	}
	if ormErr.Code != CodeDriver || ormErr.Msg != "Error 1644: trigger refused the write" {
		t.Fatalf("mapped error = (%q, %q), want DRIVER and the native message", ormErr.Code, ormErr.Msg)
	}
	var nativeCause *mysql.MySQLError
	if !errors.Is(mapped, driverErr) || !errors.As(ormErr.Cause, &nativeCause) || nativeCause != driverErr {
		t.Fatalf("mapped error does not preserve the exact driver cause: %#v", ormErr.Cause)
	}
}

func TestCellScanCopiesLosslessNativeBytes(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	source := []byte{0x00, 0x80, 0xff, 0x41}
	want := string(source)
	var cell cell
	if err := cell.Scan(source); err != nil {
		t.Fatal(err)
	}
	source[0] = 0x7f
	values := []any{cell.v}
	assemble := &plan.Assemble{Columns: []plan.OutCol{{Index: 0, Type: "bytes"}}}
	if err := restoreByteColumns(values, assemble); err != nil {
		t.Fatalf("restore scanned byte cell: %v", err)
	}
	got, ok := values[0].([]byte)
	if !ok || string(got) != want {
		t.Fatalf("restored byte cell = %T %v, want original bytes %v", values[0], got, []byte(want))
	}
}

// TestErrorClassification checks that each classification reports exactly its code, also through a wrapped error,
// and that no classification reports nil or an error without a code.
func TestErrorClassification(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	classes := map[string]func(error) bool{
		CodeDeadlock:         IsDeadlock,
		CodeLockNotAvailable: IsLockNotAvailable,
		CodeDuplicateKey:     IsDuplicateKey,
		CodeForeignKey:       IsForeignKey,
		CodeConstraint:       IsConstraint,
		CodeNoRows:           IsNoRows,
	}
	for code := range classes {
		err := fmt.Errorf("wrapped: %w", &ir.Error{Code: code, Msg: "classified"})
		for other, is := range classes {
			if got := is(err); got != (other == code) {
				t.Errorf("the %s classification of a %s error = %v", other, code, got)
			}
		}
	}
	for other, is := range classes {
		if is(nil) || is(errors.New("no code")) {
			t.Errorf("the %s classification reports an error without a code", other)
		}
	}
}
