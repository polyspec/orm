package orm_test

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

var rollbackColumns = []string{"seq", "label"}

// rollbackFixture installs rollback_probe in a new database and returns the connected model constructor
// and a function that ends the transaction behind the client. On SQLite,
// the trigger the test creates raises ROLLBACK on the insert of the row with the `end` label, so
// the transaction ends during the callback, and the ending function does nothing.
// On MySQL and PostgreSQL, the ending function ends the server session that holds the rollback_probe
// lock. That connection is not a pooler, but
// the server behind the server DSN of ORM_TEST_MYSQL_SERVER_DSN or ORM_TEST_POSTGRES_SERVER_DSN (set in TEST_ENV by make orm-test-servers)
// and opens the case database there, since a pooler handles statements on its own:
// ProxySQL receives KILL in text protocol as a command for its own client session
// command. The lock on the case database table marks the transaction held behind the pooler
// as pointing to its session.
func rollbackFixture(t *testing.T, driver string) (*orm.DB, func() *orm.Core, func()) {
	t.Helper()
	s := fixtureSchema(t, "rollback")
	dsn := newDatabase(t, driver)
	path := strings.TrimPrefix(dsn, "sqlite://")
	db, err := orm.ConnectSchema(dsn, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Utils().Schema().Install(s); err != nil {
		t.Fatal(err)
	}
	end := func() {}
	switch driver {
	case "sqlite":
		raw, err := sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		defer raw.Close()
		if _, err := raw.Exec(`CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' BEGIN SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END`); err != nil {
			t.Fatal(err)
		}
	case "postgres":
		session := serverSession(t, driver, dsn)
		end = func() {
			raw := openNative(t, driver, session)
			defer raw.Close()
			var pid int64
			if err := raw.QueryRow(`SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND c.relname = 'rollback_probe' AND l.pid <> pg_backend_pid() LIMIT 1`).Scan(&pid); err != nil {
				t.Errorf("the transaction session holds a lock on rollback_probe: %v", err)
				return
			}
			if _, err := raw.Exec(`SELECT pg_terminate_backend($1, 5000)`, pid); err != nil {
				t.Error(err)
			}
		}
	case "mysql":
		session := serverSession(t, driver, dsn)
		end = func() {
			raw := openNative(t, driver, session)
			defer raw.Close()
			var id int64
			if err := raw.QueryRow("SELECT t.PROCESSLIST_ID FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'rollback_probe' LIMIT 1").Scan(&id); err != nil {
				t.Errorf("the transaction session holds a lock on rollback_probe: %v", err)
				return
			}
			if _, err := raw.Exec("KILL ?", id); err != nil {
				t.Error(err)
			}
		}
	}
	ent := rowEntity("rollback_probe", s, rollbackColumns...)
	model := func() *orm.Core {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		return c
	}
	return db, model, end
}

// serverSession is the DSN that opens the case database dsn on the server, not on the pooler:
// it replaces the path of ORM_TEST_<DRIVER>_SERVER_DSN with the case database name.
func serverSession(t *testing.T, driver, dsn string) string {
	t.Helper()
	server := requireDSN(t, "ORM_TEST_"+strings.ToUpper(driver)+"_SERVER_DSN")
	return testdb.Retarget(t, server, testdb.DatabaseOf(t, dsn))
}

func probeCreate(model func() *orm.Core, label string) error {
	c := model()
	c.Set("label", label)
	_, err := c.Create()
	return err
}

// checkRollback checks that the ROLLBACK error unwraps into the callback error and the rollback error,
// that its message holds both, and returns the callback error.
func checkRollback(t *testing.T, err error, subject string) error {
	t.Helper()
	var coded *orm.Error
	if !errors.As(err, &coded) || coded.Code != orm.CodeRollback {
		t.Fatalf("%s = %v, want ROLLBACK", subject, err)
	}
	joined, ok := coded.Cause.(interface{ Unwrap() []error })
	if !ok || len(joined.Unwrap()) != 2 {
		t.Fatalf("%s does not keep the callback and rollback errors: %#v", subject, coded.Cause)
	}
	callback, rollback := joined.Unwrap()[0], joined.Unwrap()[1]
	if !strings.Contains(coded.Msg, callback.Error()) || !strings.Contains(coded.Msg, rollback.Error()) {
		t.Fatalf("%s message does not name both errors: %s", subject, coded.Msg)
	}
	return callback
}

// rollbackFailed makes the callback of a transaction whose rollback also fails fail.
func rollbackFailed(t *testing.T, driver string) {
	db, model, end := rollbackFixture(t, driver)
	err := db.Transaction(func() error {
		if err := probeCreate(model, "kept"); err != nil {
			return err
		}
		end()
		return probeCreate(model, "end")
	}, orm.Retry(0))
	callback := checkRollback(t, err, "transaction")
	if driver != "sqlite" {
		// The next statement and rollback on a session the server ended is a lost-connection error.
		var coded *orm.Error
		errors.As(err, &coded)
		rollback := coded.Cause.(interface{ Unwrap() []error }).Unwrap()[1]
		if orm.ErrorCode(callback) != orm.CodeConnectionLost {
			t.Errorf("the callback error is %v, want CONNECTION_LOST", callback)
		}
		if orm.ErrorCode(rollback) != orm.CodeConnectionLost {
			t.Errorf("the rollback error is %v, want CONNECTION_LOST", rollback)
		}
	}
	if driver == "sqlite" {
		if !strings.Contains(callback.Error(), "rollback probe ended the transaction") {
			t.Fatalf("callback error %v", callback)
		}
		if n, err := model().GetCount(); err != nil || n != 0 {
			t.Fatalf("after the failed rollback: %d rows, %v", n, err)
		}
	}
}

// savepointRollbackFailed makes the callback of a savepoint whose rollback fails
// fail, and then the transaction's rollback also fails.
func savepointRollbackFailed(t *testing.T, driver string) {
	db, model, end := rollbackFixture(t, driver)
	err := db.Transaction(func() error {
		if err := probeCreate(model, "kept"); err != nil {
			return err
		}
		return db.Transaction(func() error {
			if err := probeCreate(model, "nested"); err != nil {
				return err
			}
			end()
			return probeCreate(model, "end")
		})
	}, orm.Retry(0))
	callback := checkRollback(t, err, "transaction")
	checkRollback(t, callback, "savepoint")
	if driver == "sqlite" {
		if n, err := model().GetCount(); err != nil || n != 0 {
			t.Fatalf("after the failed rollback: %d rows, %v", n, err)
		}
	}
}

// Requirements: CFG-15.
func TestRollbackFailedSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	rollbackFailed(t, "sqlite")
}
func TestRollbackFailedMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	rollbackFailed(t, "mysql")
}
func TestRollbackFailedPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	rollbackFailed(t, "postgres")
}
func TestSavepointRollbackFailedSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	savepointRollbackFailed(t, "sqlite")
}
func TestSavepointRollbackFailedMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	savepointRollbackFailed(t, "mysql")
}
func TestSavepointRollbackFailedPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	savepointRollbackFailed(t, "postgres")
}
