package orm

import (
	"errors"
	"fmt"
	"testing"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/legacy/packages/go/engine/ir"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// MySQL reports a failed CHECK as 3819; its 4025 is ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE, a DRIVER error (DIA-201).
func TestMapMySQLErrClassifiesCheckConstraint(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	err := mapDriverErr(&mysql.MySQLError{Number: 3819, SQLState: [5]byte{'H', 'Y', '0', '0', '0'}, Message: "check constraint violated"}, serverMySQL)
	if got := ErrorCode(err); got != CodeConstraint || !IsConstraint(err) {
		t.Fatalf("mapped MySQL check error 3819 = %q, want %q: %v", got, CodeConstraint, err)
	}
	autoextend := mapDriverErr(&mysql.MySQLError{Number: 4025, SQLState: [5]byte{'H', 'Y', '0', '0', '0'}, Message: "AUTOEXTEND_SIZE value should be between 4M and 4096M"}, serverMySQL)
	if got := ErrorCode(autoextend); got != CodeDriver {
		t.Fatalf("mapped MySQL error 4025 = %q, want %q: %v", got, CodeDriver, autoextend)
	}
}

// MariaDB numbers its errors above 1999 otherwise than MySQL (DIA-201): each number maps by the table of its server.
func TestMapDriverErrKeysTheNumberByServer(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, c := range []struct {
		number uint16
		state  string
		mysql  string
		maria  string
	}{
		{4025, "23000", CodeDriver, CodeConstraint},
		{3819, "HY000", CodeConstraint, CodeDriver},
		{3572, "HY000", CodeLockNotAvailable, CodeDriver},
		{3024, "HY000", CodeCanceled, CodeDriver},
		{4031, "HY000", CodeConnectionLost, CodeDriver},
		{1969, "70100", CodeDriver, CodeCanceled},
		{1062, "23000", CodeDuplicateKey, CodeDuplicateKey},
		{1452, "23000", CodeForeignKey, CodeForeignKey},
		{1213, "40001", CodeDeadlock, CodeDeadlock},
		{1290, "HY000", CodeReadOnly, CodeReadOnly},
		{1205, "HY000", CodeCanceled, CodeCanceled},
	} {
		var state [5]byte
		copy(state[:], c.state)
		for server, want := range map[string]string{serverMySQL: c.mysql, serverMariaDB: c.maria} {
			if got := ErrorCode(mapDriverErr(&mysql.MySQLError{Number: c.number, SQLState: state, Message: "m"}, server)); got != want {
				t.Errorf("%s error %d = %q, want %q", server, c.number, got, want)
			}
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

func TestMapDriverErrorContextKeepsCanceledCode(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	mapped := mapCanceledDriverError()
	if ErrorCode(mapped) != CodeCanceled {
		t.Fatalf("mapped code = %q, want %s: %v", ErrorCode(mapped), CodeCanceled, mapped)
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
