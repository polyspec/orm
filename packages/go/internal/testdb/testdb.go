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
	"context"
	"database/sql"
	sqldriver "database/sql/driver"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

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

// New creates a case database for the driver ("sqlite", "mysql", "mariadb", "postgres") and
// returns its DSN. For MySQL and PostgreSQL it creates the database orm_case_<pid>_<number> on the server of ORM_TEST_<DRIVER>_DSN
// and changes only the path of the DSN to that name (the query stays as it is). SQLite uses the new file
// orm-case-<pid>-<number>.sqlite in the OS temp directory. Creating and deleting it is reported as a STEP line
// of the case (testcase.Of) wrapping t, and deletion runs in t.Cleanup, so it runs even after the case fails.
// If deletion fails, the case fails with the database name.
func New(t testing.TB, driver string) string {
	t.Helper()
	c := testcase.Of(t)
	if driver == "markdown" {
		return NewCorpus(t, "")
	}
	if driver == "sqlite" {
		path := filepath.Join(os.TempDir(), fmt.Sprintf("orm-case-%d-%d.sqlite", os.Getpid(), counter.Add(1)))
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatalf("create case file: %v", err)
		}
		if err := file.Close(); err != nil {
			t.Fatalf("close case file: %v", err)
		}
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
		t.Fatalf("%s is required; run make orm-test-servers, which starts the databases and writes it", env)
	}
	name := Name()
	admin := Open(t, driver, base)
	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		testcase.Close(t, admin)
		t.Fatalf("create case database %s: %v", name, err)
	}
	c.Step("database %s created", name)
	t.Cleanup(func() {
		defer testcase.Close(t, admin)
		if err := DropDatabase(context.Background(), admin, driver, name); err != nil {
			t.Errorf("drop case database %s: %v", name, err)
			return
		}
		c.Step("database %s dropped", name)
	})
	return Retarget(t, base, name)
}

// DropDatabase drops the database name of the server of admin. On MySQL and MariaDB it drops on one session with
// foreign_key_checks = 0 (DIA-212): a DROP DATABASE that MariaDB cannot finish logs the tables that it dropped as one
// DROP TABLE list under the checks of its session, which a replica with the checks on refuses at a parent table. That
// session is closed, not returned to the pool, so no later use of admin runs without the checks.
func DropDatabase(ctx context.Context, admin *sql.DB, driver, name string) (err error) {
	if driver == "postgres" {
		_, err = admin.ExecContext(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
		return err
	}
	conn, err := admin.Conn(ctx)
	if err != nil {
		return err
	}
	// The session turned its checks off, so it never returns to the pool: Raw returning driver.ErrBadConn makes
	// database/sql close the connection and end conn; any other result leaves conn open, and it is closed.
	defer func() {
		if discard := conn.Raw(func(any) error { return sqldriver.ErrBadConn }); !errors.Is(discard, sqldriver.ErrBadConn) {
			err = errors.Join(err, fmt.Errorf("discard the session of the drop: %w", discard), conn.Close())
		}
	}()
	if _, err = conn.ExecContext(ctx, "SET SESSION foreign_key_checks = 0"); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "DROP DATABASE "+name)
	return err
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
	// MariaDB is a server of the MySQL dialect (DIA-200), reached with the MySQL driver.
	if driver == "mysql" || driver == "mariadb" {
		cfg, err := testcase.MySQLConfig(dsn)
		if err != nil {
			t.Fatalf("parse DSN: %v", err)
		}
		sqlDriver, native = "mysql", cfg.FormatDSN()
	}
	if driver == "sqlite" {
		// the path of sqlite:///path. The driver "sqlite" is registered by a test that imports the SQLite driver package.
		sqlDriver, native = "sqlite", strings.TrimPrefix(strings.SplitN(dsn, "?", 2)[0], "sqlite://")
	}
	if driver == "markdown" {
		// The driver "markdown" is registered by orm, which a test of a corpus imports.
		sqlDriver = "markdown"
	}
	raw, err := sql.Open(sqlDriver, native)
	if err != nil {
		t.Fatalf("open %s: %v", driver, err)
	}
	return raw
}

// DirNames returns the entry names of dir in the order of os.ReadDir; a failure
// fails the test.
func DirNames(t testing.TB, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}
