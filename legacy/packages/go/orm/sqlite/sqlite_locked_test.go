package sqlite

import (
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
	"testing"
)

// Requirements: PLN-24.
func TestSqliteLockedIsDriverNotDeadlock(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, n := range []int{6, 262} {
		if got := sqliteCode(n, "database table is locked"); got != orm.CodeDriver {
			t.Fatalf("SQLITE_LOCKED %d code = %q, want %q", n, got, orm.CodeDriver)
		}
	}
}
