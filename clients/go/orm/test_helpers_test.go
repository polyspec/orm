package orm_test

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// requireDSN returns the DSN in env; an unset variable fails the test.
func requireDSN(t *testing.T, env string) string {
	t.Helper()
	dsn := os.Getenv(env)
	if dsn == "" {
		t.Fatalf("%s is required; database tests never skip", env)
	}
	return dsn
}

// requireTarget fails the test when the DSN of a MySQL or PostgreSQL target
// is unset.
func requireTarget(t *testing.T, driver, dsn string) {
	t.Helper()
	if dsn == "" && driver != "sqlite" {
		t.Fatalf("ORM_TEST_%s_DSN is required; database tests never skip", strings.ToUpper(driver))
	}
}

func dropTable(t *testing.T, driver, dsn, table string) {
	t.Helper()
	if driver == "sqlite" {
		return
	}
	raw := openNative(t, driver, dsn)
	defer raw.Close()
	stmt := `DROP TABLE IF EXISTS "` + table + `"`
	if driver == "mysql" {
		stmt = "DROP TABLE IF EXISTS `" + table + "`"
	}
	if _, err := raw.Exec(stmt); err != nil {
		t.Fatal(err)
	}
}

// openNative opens the MySQL or PostgreSQL database of a client DSN through
// the native database/sql driver.
func openNative(t *testing.T, driver, dsn string) *sql.DB {
	t.Helper()
	sqlDriver, native := "pgx", dsn
	if driver == "mysql" {
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
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
	raw, err := sql.Open(sqlDriver, native)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// newDatabase creates a database on the server that ORM_TEST_MYSQL_DSN or
// ORM_TEST_POSTGRES_DSN names, which requires the privilege to create
// databases, and returns its DSN; the database is dropped when the test ends.
// For SQLite it returns a new file.
func newDatabase(t *testing.T, driver string) string {
	t.Helper()
	if driver == "sqlite" {
		return "sqlite://" + filepath.Join(t.TempDir(), "new.sqlite")
	}
	base := requireDSN(t, "ORM_TEST_"+strings.ToUpper(driver)+"_DSN")
	name := fmt.Sprintf("orm_new_%d", time.Now().UnixNano())
	server := openNative(t, driver, base)
	if _, err := server.Exec("CREATE DATABASE " + name); err != nil {
		server.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		defer server.Close()
		stmt := "DROP DATABASE " + name
		if driver == "postgres" {
			stmt += " WITH (FORCE)"
		}
		if _, err := server.Exec(stmt); err != nil {
			t.Errorf("drop database %s: %v", name, err)
		}
	})
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	return u.String()
}
