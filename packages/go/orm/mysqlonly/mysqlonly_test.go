// Package mysqlonly_test is a program that imports packages/go/orm and neither driver package, as a MySQL-only
// program does: the tests of DIA-20 and DIA-21 (docs/spec/dialects.md, "Go driver packages"). It holds no other
// test, because importing orm/pg or orm/sqlite anywhere in this binary would register their drivers.
package mysqlonly_test

import (
	"runtime/debug"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestOrmLinksMySQLOnly reads the modules that this binary links: packages/go/orm brings the MySQL driver and
// neither pgx nor modernc.org/sqlite, which only orm/pg and orm/sqlite import (DIA-20).
func TestOrmLinksMySQLOnly(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	info, ok := debug.ReadBuildInfo()
	if !ok {
		t.Fatal("the test binary carries no build information")
	}
	linked := map[string]bool{}
	for _, m := range info.Deps {
		linked[m.Path] = true
	}
	if !linked["github.com/go-sql-driver/mysql"] {
		t.Errorf("the binary does not link github.com/go-sql-driver/mysql; linked %v", linked)
	}
	for _, path := range []string{"github.com/jackc/pgx/v5", "modernc.org/sqlite"} {
		if linked[path] {
			t.Errorf("packages/go/orm links %s, which only its driver package may import", path)
		}
	}
}

// TestOpenWithoutDriverPackageNamesTheImport connects to a PostgreSQL and a SQLite DSN in a binary that imports neither
// driver package: orm.Connect (the orm.Open of the rule) fails with CONFIG, and its message names the import that registers the driver (DIA-21).
func TestOpenWithoutDriverPackageNamesTheImport(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for dsn, pkg := range map[string]string{
		"postgres://user:secret@127.0.0.1:1/orm": "pg",
		"sqlite:///tmp/orm-mysqlonly.db":        "sqlite",
	} {
		db, err := orm.Connect(dsn, orm.Config{})
		if err == nil {
			db.Close()
			t.Errorf("Connect(%q) succeeded without the %s package", dsn, pkg)
			continue
		}
		if orm.ErrorCode(err) != orm.CodeConfig {
			t.Errorf("Connect(%q): %v, want CONFIG", dsn, err)
		}
		if want := `import _ "github.com/polyspec/orm/packages/go/orm/` + pkg + `"`; !strings.Contains(err.Error(), want) {
			t.Errorf("Connect(%q): %v, does not name %s", dsn, err, want)
		}
	}
}
