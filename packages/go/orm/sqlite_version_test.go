package orm_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"
	"github.com/polyspec/orm/packages/go/testcase"
	sqlite3 "modernc.org/sqlite/lib"
)

// Requirements: DSL-150.
func TestSQLiteMinimumVersionThroughConnect(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	previous := sqlite3.SQLITE_VERSION
	orm.RegisterSQLiteVersion("3.9.0")
	t.Cleanup(func() { orm.RegisterSQLiteVersion(previous) })

	_, err := orm.Connect("sqlite://"+filepath.Join(t.TempDir(), "old.sqlite"), orm.Config{})
	if got := orm.ErrorCode(err); got != orm.CodeCapabilityUnsupported {
		t.Fatalf("Connect with SQLite 3.9.0 returned %v (code %q); want CAPABILITY_UNSUPPORTED", err, got)
	}
	if err == nil || !strings.Contains(err.Error(), "SQLite 3.9.0 is older than 3.46") {
		t.Fatalf("Connect error = %v; want the rejected library version", err)
	}

	for _, version := range []string{"3.46.0", "3.100.0"} {
		orm.RegisterSQLiteVersion(version)
		db, connectErr := orm.Connect("sqlite://"+filepath.Join(t.TempDir(), "supported.sqlite"), orm.Config{})
		if connectErr != nil {
			t.Fatalf("Connect with SQLite %s: %v", version, connectErr)
		}
		if err := db.Close(); err != nil {
			t.Fatalf("Close after SQLite %s: %v", version, err)
		}
	}
}
