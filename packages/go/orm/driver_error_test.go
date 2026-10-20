package orm

import (
	"errors"
	"fmt"
	"testing"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/packages/go/engine/ir"
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

func TestMapMySQLErrClassifiesReadOnly(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, number := range []uint16{1290, 1792} {
		err := mapMySQLErr(&mysql.MySQLError{Number: number, Message: "read-only"})
		if got := ErrorCode(err); got != CodeReadOnly {
			t.Fatalf("mapped MySQL read-only error %d = %q, want %q: %v", number, got, CodeReadOnly, err)
		}
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
