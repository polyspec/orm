package orm

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
)

// connectBench는 schema/bench.dbspec의 manifest로 dsn에 연결한다.
func connectBench(t *testing.T, dsn string) *DB {
	t.Helper()
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "schema", "bench.dbspec"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := Connect(dsn, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// wantBoth는 err가 callback 오류와 transaction 끝의 오류를 함께 담은 CONFIG인지
// 확인한다.
func wantBoth(t *testing.T, what string, err error, cause, end string) {
	t.Helper()
	want := fmt.Sprintf("transaction failed (%s) and rollback failed (", cause)
	if ErrorCode(err) != CodeConfig || !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), end) {
		t.Fatalf("%s: want CONFIG %q with %q, got %v", what, want, end, err)
	}
}

// recovered는 fn이 panic하거나 goroutine을 끝내면 panic 값을 돌려준다.
func recovered(fn func()) (value any) {
	done := make(chan any, 1)
	go func() {
		defer func() { done <- recover() }()
		fn()
	}()
	return <-done
}

// TestTransactionReportsFailedLockRelease는 transaction 끝의 MySQL
// RELEASE_LOCK이 실패하거나 lock을 풀지 못하면 commit과 rollback이 그 오류를
// 돌려주는지 확인한다. 풀리지 않은 named lock은 pool connection에 남는다.
func TestTransactionReportsFailedLockRelease(t *testing.T) {
	dsn := os.Getenv("ORM_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN is required; database tests never skip")
	}
	useFailingDriver(t, "mysql")
	db := connectBench(t, dsn)
	key := func(name string) string { return fmt.Sprintf("orm_test.%s.%d", name, os.Getpid()) }

	releaseRejected := injectedFailure{statement: func(query string) bool { return strings.HasPrefix(query, "SELECT RELEASE_LOCK") }}
	t.Run("commit", func(t *testing.T) {
		inject(t, releaseRejected)
		err := db.Transaction(func() error { return db.Utils().Lock(key("commit")) }, Retry(0))
		if !errors.Is(err, errStatementRejected) {
			t.Fatalf("want the release error, got %v", err)
		}
	})
	t.Run("rollback", func(t *testing.T) {
		inject(t, releaseRejected)
		err := db.Transaction(func() error {
			if err := db.Utils().Lock(key("rollback")); err != nil {
				return err
			}
			return errors.New("callback failed")
		}, Retry(0))
		wantBoth(t, "rollback", err, "callback failed", errStatementRejected.Error())
	})
	t.Run("not held", func(t *testing.T) {
		err := db.Transaction(func() error {
			if err := db.Utils().Lock(key("released")); err != nil {
				return err
			}
			// lock을 미리 풀면 transaction 끝의 RELEASE_LOCK은 0을 돌려준다.
			_, err := activeFor(db).tx.Exec("DO RELEASE_LOCK(?)", key("released"))
			return err
		}, Retry(0))
		if want := "lock " + key("released") + " was not held at transaction end"; err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("want %q, got %v", want, err)
		}
	})
}

// TestTransactionReportsFailedRollback는 native rollback이 실패하면 callback
// 오류, panic, 끝나 버린 callback, 실패한 begin이 그 오류를 함께 보고하는지
// 확인한다.
func TestTransactionReportsFailedRollback(t *testing.T) {
	useFailingDriver(t, "sqlite")
	db := connectBench(t, "sqlite://"+filepath.Join(t.TempDir(), "rollback.sqlite"))

	rollbackRejected := injectedFailure{rollback: true}
	t.Run("callback error", func(t *testing.T) {
		inject(t, rollbackRejected)
		err := db.Transaction(func() error { return errors.New("callback failed") }, Retry(0))
		wantBoth(t, "callback error", err, "callback failed", errRollbackRejected.Error())
	})
	t.Run("panic", func(t *testing.T) {
		inject(t, rollbackRejected)
		value := recovered(func() {
			_ = db.Transaction(func() error { panic("callback panicked") }, Retry(0))
		})
		err, _ := value.(error)
		wantBoth(t, "panic", err, "callback panicked", errRollbackRejected.Error())
	})
	t.Run("goexit", func(t *testing.T) {
		inject(t, rollbackRejected)
		value := recovered(func() {
			_ = db.Transaction(func() error { runtime.Goexit(); return nil }, Retry(0))
		})
		err, _ := value.(error)
		wantBoth(t, "goexit", err, "callback exited without returning", errRollbackRejected.Error())
	})
	t.Run("begin", func(t *testing.T) {
		inject(t, injectedFailure{statement: func(query string) bool { return query == "PRAGMA query_only = 1" }, rollback: true})
		err := db.Transaction(func() error { return nil }, ReadOnly(), Retry(0))
		wantBoth(t, "begin", err, errStatementRejected.Error(), errRollbackRejected.Error())
	})
	t.Run("panic with a successful rollback", func(t *testing.T) {
		value := recovered(func() {
			_ = db.Transaction(func() error { panic("callback panicked") }, Retry(0))
		})
		if value != "callback panicked" {
			t.Fatalf("want the callback's panic value, got %v", value)
		}
	})
}

// TestTransactionReportsFailedSQLiteModeReset는 SQLite read-only mode를 되돌리는
// PRAGMA가 실패하면 commit과 rollback이 그 오류를 돌려주는지 확인한다. 되돌리지
// 못한 query_only는 connection에 남는다.
func TestTransactionReportsFailedSQLiteModeReset(t *testing.T) {
	useFailingDriver(t, "sqlite")
	db := connectBench(t, "sqlite://"+filepath.Join(t.TempDir(), "mode.sqlite"))
	modeRejected := injectedFailure{statement: func(query string) bool { return query == "PRAGMA query_only = 0" }}
	t.Run("commit", func(t *testing.T) {
		inject(t, modeRejected)
		err := db.Transaction(func() error { return nil }, ReadOnly(), Retry(0))
		if !errors.Is(err, errStatementRejected) {
			t.Fatalf("want the mode reset error, got %v", err)
		}
	})
	t.Run("rollback", func(t *testing.T) {
		inject(t, modeRejected)
		err := db.Transaction(func() error { return errors.New("callback failed") }, ReadOnly(), Retry(0))
		wantBoth(t, "rollback", err, "callback failed", errStatementRejected.Error())
	})
}
