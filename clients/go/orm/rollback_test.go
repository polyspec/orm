package orm_test

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
)

var rollbackColumns = []string{"seq", "label"}

// rollbackFixture는 rollback_probe를 새 database에 설치하고 연결된 model 생성
// 함수와 client 뒤에서 transaction을 끝내는 함수를 돌려준다. SQLite에서는
// test가 만든 trigger가 `end` label의 row insert에서 ROLLBACK을 raise하므로
// transaction이 callback 중에 끝나고 끝내는 함수는 아무것도 하지 않는다.
// MySQL과 PostgreSQL에서는 끝내는 함수가 test connection에서 rollback_probe의
// lock을 가진 server session을 끝낸다.
func rollbackFixture(t *testing.T, driver string) (*orm.DB, func() *orm.Core, func()) {
	t.Helper()
	s := fixtureSchema(t, "rollback")
	dsn := newDatabase(t, driver)
	path := strings.TrimPrefix(dsn, "sqlite://")
	db, err := orm.Connect(dsn, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Utils().Schema().Install(s.Text); err != nil {
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
	ent := rowEntity("rollback_probe", s, rollbackColumns...)
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

// checkRollback은 ROLLBACK 오류가 callback 오류와 rollback 오류로 unwrap되고
// message가 둘을 모두 담는지 확인하고 callback 오류를 돌려준다.
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

// rollbackFailed는 rollback도 실패하는 transaction의 callback을 실패시킨다.
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

// savepointRollbackFailed는 rollback이 실패하는 savepoint의 callback을
// 실패시키고, 이어 transaction의 rollback도 실패한다.
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
