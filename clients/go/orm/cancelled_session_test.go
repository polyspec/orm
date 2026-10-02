package orm

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
)

// TestCancelledTransactionClearsSessionState는 callback 중에 context가 취소된
// transaction이 named lock, user variable, SQLite mode를 connection에 남기지 않고
// 취소만 보고하는지 확인한다. context가 취소되면 database/sql이 transaction을
// rollback하고, driver.SessionResetter와 driver.Validator를 구현한 driver의
// connection은 pool로 돌아간다. connection이 하나인 pool의 다음 transaction은
// 같은 session을 다시 쓰면 그 상태를 읽는다.
func TestCancelledTransactionClearsSessionState(t *testing.T) {
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "schema", "bench.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	connectOne := func(t *testing.T, dsn string) *DB {
		t.Helper()
		db, err := Connect(dsn, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}, Config{PoolSize: 1})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Close() })
		return db
	}
	key := fmt.Sprintf("orm_test.cancelled.%d", os.Getpid())
	// cancelled는 fn을 실행한 뒤 context를 취소하는 transaction이 CANCELED만 돌려주는지 확인한다.
	cancelled := func(t *testing.T, db *DB, fn func(handle *DB) error, options ...TransactionOption) {
		t.Helper()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		handle := db.WithContext(ctx)
		err := handle.Transaction(func() error {
			if err := fn(handle); err != nil {
				return err
			}
			cancel()
			return nil
		}, append(options, Retry(0))...)
		if ErrorCode(err) != CodeCanceled {
			t.Errorf("want CANCELED alone, got %v", err)
		}
	}
	lockAndSet := func(handle *DB) error {
		if err := handle.Utils().Lock(key); err != nil {
			return err
		}
		return handle.Utils().SetLocal("ormtest.cancelled", "tester")
	}

	t.Run("mysql", func(t *testing.T) {
		dsn := os.Getenv("ORM_TEST_MYSQL_DSN")
		if dsn == "" {
			t.Fatal("ORM_TEST_MYSQL_DSN is required; database tests never skip")
		}
		db, other := connectOne(t, dsn), connectBench(t, dsn)
		cancelled(t, db, lockAndSet)
		// 끝난 session의 lock이 풀릴 때까지 server가 5초까지 기다린다.
		var got sql.NullInt64
		if err := other.sql.QueryRow("SELECT GET_LOCK(?, 5)", key).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if !got.Valid || got.Int64 != 1 {
			t.Errorf("the lock %s is still held after the cancelled transaction: GET_LOCK returned %v", key, got)
		} else if _, err := other.sql.Exec("DO RELEASE_LOCK(?)", key); err != nil {
			t.Fatal(err)
		}
		var local sql.NullString
		if err := db.Transaction(func() error {
			return activeFor(db).tx.QueryRow("SELECT @`orm.ormtest.cancelled`").Scan(&local)
		}, Retry(0)); err != nil {
			t.Fatal(err)
		}
		if local.Valid {
			t.Errorf("the next transaction reads the user variable of the cancelled transaction: %q", local.String)
		}
	})
	t.Run("postgres", func(t *testing.T) {
		dsn := os.Getenv("ORM_TEST_POSTGRES_DSN")
		if dsn == "" {
			t.Fatal("ORM_TEST_POSTGRES_DSN is required; database tests never skip")
		}
		db, other := connectOne(t, dsn), connectBench(t, dsn)
		cancelled(t, db, lockAndSet)
		// 다른 connection이 lock_timeout 안에 같은 advisory lock을 잡는다.
		if err := other.Transaction(func() error {
			tx := activeFor(other).tx
			if _, err := tx.Exec("SET LOCAL lock_timeout = '5s'"); err != nil {
				return err
			}
			_, err := tx.Exec("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", key)
			return err
		}, Retry(0)); err != nil {
			t.Errorf("the lock %s is still held after the cancelled transaction: %v", key, err)
		}
		var local sql.NullString
		if err := db.Transaction(func() error {
			return activeFor(db).tx.QueryRow("SELECT current_setting('ormtest.cancelled', true)").Scan(&local)
		}, Retry(0)); err != nil {
			t.Fatal(err)
		}
		if local.String != "" {
			t.Errorf("the next transaction reads the local value of the cancelled transaction: %q", local.String)
		}
	})
	t.Run("sqlite", func(t *testing.T) {
		db := connectOne(t, "sqlite://"+filepath.Join(t.TempDir(), "cancelled.sqlite"))
		cancelled(t, db, func(*DB) error { return nil }, ReadOnly())
		var queryOnly int
		if err := db.Transaction(func() error {
			return activeFor(db).tx.QueryRow("PRAGMA query_only").Scan(&queryOnly)
		}, Retry(0)); err != nil {
			t.Fatal(err)
		}
		if queryOnly != 0 {
			t.Errorf("the next transaction runs with query_only = %d of the cancelled read-only transaction", queryOnly)
		}
	})
}
