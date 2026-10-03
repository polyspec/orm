package orm_test

import (
	"database/sql"
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testdb"
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

// openNative opens the MySQL or PostgreSQL database of a client DSN through
// the native database/sql driver.
func openNative(t *testing.T, driver, dsn string) *sql.DB {
	t.Helper()
	return testdb.Open(t, driver, dsn)
}

// newDatabase returns the DSN of a case database of its own for driver
// (internal/testdb): a new MySQL or PostgreSQL database on the server of
// ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN, or a new SQLite file, dropped
// when the test ends.
func newDatabase(t *testing.T, driver string) string {
	t.Helper()
	return testdb.New(t, driver)
}
