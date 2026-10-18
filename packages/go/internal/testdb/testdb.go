// Package testdb creates the database that one database case uses alone (the case database).
//
// The database that ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN point to is shared by several runs and sessions,
// so it cannot be assumed empty. Installing a schema or checking for an empty database
// A case creates its own database with New, and the database is deleted when the case ends (even after a failure).
// The shared DSN is used only as an admin connection and creates nothing in its database.
//
// PostgreSQL also creates a database, not a schema. Empty() counts the non-public schemas
// by their content, so an empty database cannot be checked with a case schema inside a shared database.
package testdb

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/polyspec/orm/packages/go/testcase"
)

// counter is the number of the case database created by this process. The name is determined by the process id and this number,
// so concurrently running processes do not overlap.
var counter atomic.Int64

// Name returns the next case database name, orm_case_<pid>_<number>. For a case that cannot create a database,
// such as a case bound to one PgBouncer database, it is used as its table name.
func Name() string {
	return fmt.Sprintf("orm_case_%d_%d", os.Getpid(), counter.Add(1))
}

// New creates a case database for the driver ("sqlite", "mysql", "postgres") and
// returns its DSN. For MySQL and PostgreSQL it creates the database orm_case_<pid>_<number> on the server of ORM_TEST_<DRIVER>_DSN
// and changes only the path of the DSN to that name (the query stays as it is). SQLite uses the new file
// orm-case-<pid>-<number>.sqlite in the OS temp directory. Creating and deleting it is reported as a STEP line
// of the case (testcase.Of) wrapping t, and deletion runs in t.Cleanup, so it runs even after the case fails.
// If deletion fails, the case fails with the database name.
func New(t testing.TB, driver string) string {
	t.Helper()
	c := testcase.Of(t)
	if driver == "sqlite" {
		path := filepath.Join(os.TempDir(), fmt.Sprintf("orm-case-%d-%d.sqlite", os.Getpid(), counter.Add(1)))
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatalf("create case file: %v", err)
		}
		file.Close()
		c.Step("file %s created", path)
		t.Cleanup(func() {
			for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
				if err := os.Remove(path + suffix); err != nil && !os.IsNotExist(err) {
					t.Errorf("remove case file %s: %v", path+suffix, err)
					return
				}
			}
			c.Step("file %s removed", path)
		})
		return "sqlite://" + path
	}
	env := "ORM_TEST_" + strings.ToUpper(driver) + "_DSN"
	base := os.Getenv(env)
	if base == "" {
		t.Fatalf("%s is required; database tests never skip", env)
	}
	name := Name()
	admin := Open(t, driver, base)
	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		admin.Close()
		t.Fatalf("create case database %s: %v", name, err)
	}
	c.Step("database %s created", name)
	t.Cleanup(func() {
		defer admin.Close()
		stmt := "DROP DATABASE " + name
		if driver == "postgres" {
			stmt += " WITH (FORCE)"
		}
		if _, err := admin.Exec(stmt); err != nil {
			t.Errorf("drop case database %s: %v", name, err)
			return
		}
		c.Step("database %s dropped", name)
	})
	return Retarget(t, base, name)
}

// Retarget is the DSN with the path of dsn changed to the database name. Use it to open the case database
// on another server (replica) under the same name.
func Retarget(t testing.TB, dsn, name string) string {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse DSN: %v", err)
	}
	u.Path = "/" + name
	return u.String()
}

// DatabaseOf is the database name of a MySQL or PostgreSQL DSN.
func DatabaseOf(t testing.TB, dsn string) string {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse DSN: %v", err)
	}
	return strings.TrimPrefix(u.Path, "/")
}

// Open opens the database of a MySQL or PostgreSQL client DSN
// with the native database/sql driver.
func Open(t testing.TB, driver, dsn string) *sql.DB {
	t.Helper()
	sqlDriver, native := "pgx", dsn
	if driver == "mysql" {
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatalf("parse DSN: %v", err)
		}
		cfg := mysql.NewConfig()
		cfg.User = u.User.Username()
		cfg.Passwd, _ = u.User.Password()
		cfg.DBName = strings.TrimPrefix(u.Path, "/")
		cfg.Net, cfg.Addr = "tcp", u.Host
		if socket := u.Query().Get("socket"); socket != "" {
			cfg.Net, cfg.Addr = "unix", socket
		}
		sqlDriver, native = "mysql", cfg.FormatDSN()
	}
	if driver == "sqlite" {
		// the path of sqlite:///path. The driver "sqlite" is registered by a test that imports the SQLite driver package.
		sqlDriver, native = "sqlite", strings.TrimPrefix(strings.SplitN(dsn, "?", 2)[0], "sqlite://")
	}
	raw, err := sql.Open(sqlDriver, native)
	if err != nil {
		t.Fatalf("open %s: %v", driver, err)
	}
	return raw
}
