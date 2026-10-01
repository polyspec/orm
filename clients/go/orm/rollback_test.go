package orm_test

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

var rollbackColumns = []string{"seq", "label"}

func rollbackEntity(hash string) *orm.Entity {
	return &orm.Entity{
		Name:   "rollback_probe",
		Schema: &orm.Schema{Hash: hash},
		New: func(c *orm.Core) orm.Model {
			r := &keywordRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) (bool, error) {
			for _, c := range rollbackColumns {
				if c == name {
					m.(*keywordRow).vals[name] = v
					return true, nil
				}
			}
			return false, nil
		},
		Value: func(m orm.Model, name string) (any, bool) {
			v, ok := m.(*keywordRow).vals[name]
			return v, ok
		},
		Collect: func(keys []orm.Key, items map[orm.Key]*orm.Core, fetched map[orm.Key]any) any {
			return orm.CollectOf[*keywordRow](keys, items, fetched)
		},
	}
}

// rollbackFixture installs rollback_probe and returns a constructor of
// connected models and the function that ends the transaction behind the
// client. On SQLite a trigger of the fixture raises ROLLBACK when a row
// labeled `end` is inserted, so the transaction ends during the callback and
// the end function does nothing. On MySQL and PostgreSQL the end function
// ends, from a test connection, the server session that holds a lock on
// rollback_probe.
func rollbackFixture(t *testing.T, driver string) (*orm.DB, func() *orm.Core, func()) {
	t.Helper()
	manifest, err := os.ReadFile("../../../contracts/fixtures/rollback_schema.json")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Load(manifest)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "rollback.sqlite")
	dsn := "sqlite://" + path
	if driver != "sqlite" {
		dsn = requireDSN(t, "ORM_TEST_"+strings.ToUpper(driver)+"_DSN")
		dropTable(t, driver, dsn, "rollback_probe")
		t.Cleanup(func() { dropTable(t, driver, dsn, "rollback_probe") })
	}
	eng, err := engine.New(m, driver)
	if err != nil {
		t.Fatal(err)
	}
	db, err := orm.Open(dsn, eng, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Utils().Schema().Install(manifest); err != nil {
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
		end = func() {
			raw := openNative(t, driver, dsn)
			defer raw.Close()
			var pid int64
			if err := raw.QueryRow(`SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'rollback_probe' AND l.pid <> pg_backend_pid() LIMIT 1`).Scan(&pid); err != nil {
				t.Errorf("the transaction session holds a lock on rollback_probe: %v", err)
				return
			}
			if _, err := raw.Exec(`SELECT pg_terminate_backend($1, 5000)`, pid); err != nil {
				t.Error(err)
			}
		}
	case "mysql":
		end = func() {
			raw := openNative(t, driver, dsn)
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
	ent := rollbackEntity(m.SchemaHash)
	model := func() *orm.Core {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		return c
	}
	return db, model, end
}

func probeCreate(model func() *orm.Core, label string) error {
	c := model()
	c.Set("label", label)
	_, err := c.Create()
	return err
}

// checkRollback checks a ROLLBACK error: it unwraps to the callback error
// and the rollback error, and its message names both. It returns the
// callback error.
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

// rollbackFailed fails the callback of a transaction whose rollback fails.
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
	if driver == "sqlite" {
		if !strings.Contains(callback.Error(), "rollback probe ended the transaction") {
			t.Fatalf("callback error %v", callback)
		}
		if n, err := model().GetCount(); err != nil || n != 0 {
			t.Fatalf("after the failed rollback: %d rows, %v", n, err)
		}
	}
}

// savepointRollbackFailed fails the callback of a savepoint whose rollback
// fails, and then the rollback of the transaction fails.
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

func TestRollbackFailedSQLite(t *testing.T)            { rollbackFailed(t, "sqlite") }
func TestRollbackFailedMySQL(t *testing.T)             { rollbackFailed(t, "mysql") }
func TestRollbackFailedPostgres(t *testing.T)          { rollbackFailed(t, "postgres") }
func TestSavepointRollbackFailedSQLite(t *testing.T)   { savepointRollbackFailed(t, "sqlite") }
func TestSavepointRollbackFailedMySQL(t *testing.T)    { savepointRollbackFailed(t, "mysql") }
func TestSavepointRollbackFailedPostgres(t *testing.T) { savepointRollbackFailed(t, "postgres") }
