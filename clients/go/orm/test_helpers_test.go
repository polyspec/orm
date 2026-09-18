package orm_test

import (
	"database/sql"
	"net/url"
	"os"
	"strings"
	"testing"

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
	sqlDriver, native := driver, dsn
	switch driver {
	case "sqlite":
		return
	case "postgres":
		sqlDriver = "pgx"
	case "mysql":
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		cfg := mysql.NewConfig()
		cfg.User = u.User.Username()
		cfg.DBName = strings.TrimPrefix(u.Path, "/")
		cfg.Net, cfg.Addr = "tcp", u.Host
		if socket := u.Query().Get("socket"); socket != "" {
			cfg.Net, cfg.Addr = "unix", socket
		}
		native = cfg.FormatDSN()
	}
	raw, err := sql.Open(sqlDriver, native)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	stmt := `DROP TABLE IF EXISTS "` + table + `"`
	if driver == "mysql" {
		stmt = "DROP TABLE IF EXISTS `" + table + "`"
	}
	if _, err := raw.Exec(stmt); err != nil {
		t.Fatal(err)
	}
}
