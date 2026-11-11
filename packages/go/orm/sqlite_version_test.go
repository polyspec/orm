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

// Requirements: DSL-150.
func TestSQLiteVersionMalformedIsInternal(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	previous := sqlite3.SQLITE_VERSION
	t.Cleanup(func() { orm.RegisterSQLiteVersion(previous) })
	for _, version := range []string{"3.46", "3.46.0.0.0", "3..0", ".46.0", " 3.46.0", "3.46.0 ", "3.46.0\n", "3.46.0\r", "3.46.0\u2028", "3.46.0\u2029", "+3.46.0", "3.46.0-rc1", "3.4294967296.0", "3.46.0.4294967296", "3.46.0.", "\u0663.46.0"} {
		orm.RegisterSQLiteVersion(version)
		_, err := orm.Connect("sqlite://"+filepath.Join(t.TempDir(), "bad.sqlite"), orm.Config{})
		if got := orm.ErrorCode(err); got != orm.CodeInternal {
			t.Fatalf("Connect with SQLite %q returned %v (code %q); want INTERNAL", version, err, got)
		}
	}
	orm.RegisterSQLiteVersion("3.46.0\n")
	_, err := orm.Connect("sqlite://"+filepath.Join(t.TempDir(), "bad.sqlite"), orm.Config{})
	if want := "INTERNAL: SQLite library version \"3.46.0\\n\" is invalid; expected three or four decimal components that each fit u32"; err == nil || err.Error() != want {
		t.Fatalf("Connect error = %v; want %s", err, want)
	}
	for _, version := range []string{"3.45.999", "2.999.999", "003.045.999.0"} {
		orm.RegisterSQLiteVersion(version)
		_, err := orm.Connect("sqlite://"+filepath.Join(t.TempDir(), "old.sqlite"), orm.Config{})
		if got := orm.ErrorCode(err); got != orm.CodeCapabilityUnsupported {
			t.Fatalf("Connect with SQLite %q returned %v (code %q); want CAPABILITY_UNSUPPORTED", version, err, got)
		}
	}
	for _, version := range []string{"3.046.000.0", "4294967295.0.0"} {
		orm.RegisterSQLiteVersion(version)
		db, err := orm.Connect("sqlite://"+filepath.Join(t.TempDir(), "ok.sqlite"), orm.Config{})
		if err != nil {
			t.Fatalf("Connect with SQLite %s: %v", version, err)
		}
		if err := db.Close(); err != nil {
			t.Fatalf("Close after SQLite %s: %v", version, err)
		}
	}
}
