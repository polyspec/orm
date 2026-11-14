package testdb

import (
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestDropDatabaseDiscardsItsSessionMysql and TestDropDatabaseDiscardsItsSessionMariadb are the case of
// dropDatabaseDiscardsItsSession on the two servers of the MySQL dialect (DIA-200, DIA-212). The MariaDB entry needs the
// MariaDB servers, which go-test-check does not hold; make mariadb-recipes-check/go runs it.
func TestDropDatabaseDiscardsItsSessionMysql(t *testing.T) {
	dropDatabaseDiscardsItsSession(t, testcase.Start(t), "mysql")
}

func TestDropDatabaseDiscardsItsSessionMariadb(t *testing.T) {
	dropDatabaseDiscardsItsSession(t, testcase.Start(t), "mariadb")
}

// dropDatabaseDiscardsItsSession drops a database through an admin pool of one connection and then reads the
// foreign_key_checks of the next session of that pool: the session of the drop turned the checks off (DIA-212), so it
// must not return to the pool, and the next session has them on.
func dropDatabaseDiscardsItsSession(t *testing.T, c *testcase.Case, driver string) {
	env := "ORM_TEST_" + strings.ToUpper(driver) + "_DSN"
	base := os.Getenv(env)
	if base == "" {
		t.Fatalf("%s is required; run make orm-test-servers or make orm-test-mariadb, which start the databases and write it", env)
	}
	ctx := c.Context()
	admin := Open(t, driver, base)
	defer testcase.Close(t, admin)
	admin.SetMaxOpenConns(1)
	admin.SetMaxIdleConns(1)
	name := Name()
	if _, err := admin.ExecContext(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database %s: %v", name, err)
	}
	c.Step("database %s created", name)
	if err := DropDatabase(ctx, admin, driver, name); err != nil {
		t.Fatalf("drop database %s: %v", name, err)
	}
	c.Step("database %s dropped", name)
	var checks int
	if err := admin.QueryRowContext(ctx, "SELECT @@SESSION.foreign_key_checks").Scan(&checks); err != nil {
		t.Fatalf("read foreign_key_checks: %v", err)
	}
	if checks != 1 {
		t.Fatalf("the next session of the admin pool has foreign_key_checks %d, want 1", checks)
	}
	c.Step("the next session of the admin pool has foreign_key_checks 1")
}
