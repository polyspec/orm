package orm

import (
	"testing"

	"github.com/go-sql-driver/mysql"
)

func TestMapMySQLErrClassifiesCheckConstraint(t *testing.T) {
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
