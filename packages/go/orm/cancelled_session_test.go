package orm

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCancelledTransactionClearsSessionState checks that a transaction whose context is canceled during its callback
// leaves no named lock, user variable, or SQLite mode on the connection,
// and reports only the cancellation. When the context is canceled, database/sql rolls back the transaction,
// and a driver that implements driver.SessionResetter and driver.Validator
// returns its connection to the pool. The next transaction in a pool with one connection
// reuses the same session and reads its state.
// Requirements: CFG-30.
func TestCancelledTransactionClearsSessionState(t *testing.T) {
	testcase.Start(t, testcase.Database)
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "contracts", "fixtures", "bench", "bench.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	connectOne := func(t *testing.T, dsn string) *DB {
		t.Helper()
		db, err := ConnectSchema(dsn, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}, Config{PoolSize: 1})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { testcase.Close(t, db) })
		return db
	}
	key := fmt.Sprintf("orm_test.cancelled.%d", os.Getpid())
	// cancelled checks that a transaction which cancels the context after running fn returns only CANCELED.
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
			t.Fatal("ORM_TEST_MYSQL_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers")
		}
		db, other := connectOne(t, dsn), connectBench(t, dsn)
		cancelled(t, db, lockAndSet)
		// The server waits up to 5 seconds for the lock of the finished session to be released.
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
			return withActive(db, func(active *txConn) error {
				return active.conn.QueryRowContext(context.Background(), "SELECT @`orm.ormtest.cancelled`").Scan(&local)
			})
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
			t.Fatal("ORM_TEST_POSTGRES_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers")
		}
		db, other := connectOne(t, dsn), connectBench(t, dsn)
		cancelled(t, db, lockAndSet)
		// Another connection takes the same advisory lock within lock_timeout.
		if err := other.Transaction(func() error {
			active, activeErr := activeFor(other)
			if activeErr != nil {
				return activeErr
			}
			tx := active.conn
			if _, err := tx.ExecContext(context.Background(), "SET LOCAL lock_timeout = '5s'"); err != nil {
				return err
			}
			_, err := tx.ExecContext(context.Background(), "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", key)
			return err
		}, Retry(0)); err != nil {
			t.Errorf("the lock %s is still held after the cancelled transaction: %v", key, err)
		}
		var local sql.NullString
		if err := db.Transaction(func() error {
			return withActive(db, func(active *txConn) error {
				return active.conn.QueryRowContext(context.Background(), "SELECT current_setting('ormtest.cancelled', true)").Scan(&local)
			})
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
			return withActive(db, func(active *txConn) error {
				return active.conn.QueryRowContext(context.Background(), "PRAGMA query_only").Scan(&queryOnly)
			})
		}, Retry(0)); err != nil {
			t.Fatal(err)
		}
		if queryOnly != 0 {
			t.Errorf("the next transaction runs with query_only = %d of the cancelled read-only transaction", queryOnly)
		}
	})
}

// withActive runs fn with the active transaction of db; a call without an active transaction is an error.
func withActive(db *DB, fn func(active *txConn) error) error {
	active, err := activeFor(db)
	if err != nil {
		return err
	}
	if active == nil {
		return configErr("no transaction is active on the connection")
	}
	return fn(active)
}

// as returns v as a T; a value of another type fails the test.
func as[T any](t testing.TB, v any) T {
	t.Helper()
	out, err := asErr[T](v)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// asErr returns v as a T, or an error when v is another type.
func asErr[T any](v any) (T, error) {
	out, ok := v.(T)
	if !ok {
		var zero T
		return zero, fmt.Errorf("value is %T, not %T", v, zero)
	}
	return out, nil
}
