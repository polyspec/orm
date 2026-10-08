package orm

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
)

// connectBench는 schema/bench.dbs의 manifest로 dsn에 연결한다.
func connectBench(t *testing.T, dsn string) *DB {
	t.Helper()
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "schema", "bench.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := ConnectSchema(dsn, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// wantBoth는 err가 callback 오류와 transaction 끝의 오류를 함께 담은 ROLLBACK인지
// 확인한다.
func wantBoth(t *testing.T, what string, err error, cause, end string) {
	t.Helper()
	want := fmt.Sprintf("transaction failed (%s) and rollback failed (", cause)
	if ErrorCode(err) != CodeRollback || !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), end) {
		t.Fatalf("%s: want ROLLBACK %q with %q, got %v", what, want, end, err)
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
// 돌려주는지 확인한다. 그 connection은 pool에 돌아가지 않는다(TestFailedTransactionEndDiscardsConnection).
func TestTransactionReportsFailedLockRelease(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := os.Getenv("ORM_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers")
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
			_, err := activeFor(db).conn.ExecContext(context.Background(), "DO RELEASE_LOCK(?)", key("released"))
			return err
		}, Retry(0))
		if want := "lock " + key("released") + " was not held at transaction end"; err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("want %q, got %v", want, err)
		}
	})
}

// TestFailedTransactionEndDiscardsConnection은 transaction 끝의 정리(named lock 해제, native rollback)가
// 실패하면 그 connection을 pool에 돌려주지 않고 버리는지 확인한다. 실패한 정리 뒤 session의 상태는 알 수
// 없으므로, pool에 돌아가는 connection은 깨끗하거나 버려진다. connection이 하나인 pool에서 다음 사용이
// 같은 session(CONNECTION_ID)을 받으면 연결이 돌아간 것이고, 풀리지 않은 named lock은 그 session에 남는다.
func TestFailedTransactionEndDiscardsConnection(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := os.Getenv("ORM_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers")
	}
	useFailingDriver(t, "mysql")
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "schema", "bench.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := ConnectSchema(dsn, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}, Config{PoolSize: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	other := connectBench(t, dsn)
	session := func(t *testing.T) int64 {
		t.Helper()
		var id int64
		if err := db.sql.QueryRow("SELECT CONNECTION_ID()").Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	key := func(name string) string { return fmt.Sprintf("orm_test.discard.%s.%d", name, os.Getpid()) }
	// free는 다른 connection이 lock을 5초 안에 얻을 수 있는지다. 끝난 session의 lock은 server가 곧 푼다.
	free := func(t *testing.T, key string) bool {
		t.Helper()
		var got sql.NullInt64
		if err := other.sql.QueryRow("SELECT GET_LOCK(?, 5)", key).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got.Valid && got.Int64 == 1 {
			if _, err := other.sql.Exec("DO RELEASE_LOCK(?)", key); err != nil {
				t.Fatal(err)
			}
			return true
		}
		return false
	}
	releaseRejected := injectedFailure{statement: func(query string) bool { return strings.HasPrefix(query, "SELECT RELEASE_LOCK") }}

	t.Run("clean end keeps the connection", func(t *testing.T) {
		before := session(t)
		if err := db.Transaction(func() error { return db.Utils().Lock(key("clean")) }, Retry(0)); err != nil {
			t.Fatal(err)
		}
		if after := session(t); after != before {
			t.Fatalf("a transaction that ended cleanly changed the session from %d to %d", before, after)
		}
	})
	for _, c := range []struct {
		name    string
		failure injectedFailure
		fail    bool
	}{
		{"release rejected at rollback", releaseRejected, true},
		{"release rejected at commit", releaseRejected, false},
		{"rollback rejected", injectedFailure{rollback: true}, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			before := session(t)
			lock := key(strings.ReplaceAll(c.name, " ", "_"))
			func() {
				inject(t, c.failure)
				defer injected.Store(nil)
				err := db.Transaction(func() error {
					if err := db.Utils().Lock(lock); err != nil {
						return err
					}
					if c.fail {
						return errors.New("callback failed")
					}
					return nil
				}, Retry(0))
				if err == nil {
					t.Fatal("the transaction end did not report the injected failure")
				}
			}()
			if after := session(t); after == before {
				t.Errorf("session %d returned to the pool after its transaction end failed", before)
			}
			if !free(t, lock) {
				t.Errorf("the lock %s is still held after its transaction end failed", lock)
			}
		})
	}
}

// TestTransactionReportsFailedRollback는 native rollback이 실패하면 callback
// 오류, panic, 끝나 버린 callback, 실패한 begin이 그 오류를 함께 보고하는지
// 확인한다.
func TestTransactionReportsFailedRollback(t *testing.T) {
	testcase.Start(t, testcase.Database)
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
		wantBoth(t, "begin", err, "DRIVER: "+errStatementRejected.Error(), errRollbackRejected.Error())
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
	testcase.Start(t, testcase.Database)
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

// TestSavepointReportsFailedEnd는 중첩 transaction의 savepoint를 끝내는
// ROLLBACK TO SAVEPOINT나 RELEASE SAVEPOINT가 실패하면 callback 오류, panic,
// 끝나 버린 callback이 그 오류를 함께 보고하고 성공한 callback은 실패한
// RELEASE SAVEPOINT를 돌려주는지 확인한다.
func TestSavepointReportsFailedEnd(t *testing.T) {
	testcase.Start(t, testcase.Database)
	useFailingDriver(t, "sqlite")
	db := connectBench(t, "sqlite://"+filepath.Join(t.TempDir(), "savepoint.sqlite"))
	rejected := func(prefix string) injectedFailure {
		return injectedFailure{statement: func(query string) bool { return strings.HasPrefix(query, prefix) }}
	}
	nested := func(fn func() error) error {
		return db.Transaction(func() error { return db.Transaction(fn) }, Retry(0))
	}
	for _, statement := range []string{"ROLLBACK TO SAVEPOINT", "RELEASE SAVEPOINT"} {
		t.Run(statement+"/callback error", func(t *testing.T) {
			inject(t, rejected(statement))
			err := nested(func() error { return errors.New("callback failed") })
			wantBoth(t, "callback error", err, "callback failed", errStatementRejected.Error())
		})
		t.Run(statement+"/panic", func(t *testing.T) {
			inject(t, rejected(statement))
			value := recovered(func() { _ = nested(func() error { panic("callback panicked") }) })
			err, _ := value.(error)
			wantBoth(t, "panic", err, "callback panicked", errStatementRejected.Error())
		})
		t.Run(statement+"/goexit", func(t *testing.T) {
			inject(t, rejected(statement))
			value := recovered(func() { _ = nested(func() error { runtime.Goexit(); return nil }) })
			err, _ := value.(error)
			wantBoth(t, "goexit", err, "callback exited without returning", errStatementRejected.Error())
		})
	}
	t.Run("RELEASE SAVEPOINT/success", func(t *testing.T) {
		inject(t, rejected("RELEASE SAVEPOINT"))
		if err := nested(func() error { return nil }); !errors.Is(err, errStatementRejected) {
			t.Fatalf("want the release error, got %v", err)
		}
	})
	t.Run("both statements", func(t *testing.T) {
		inject(t, injectedFailure{statement: func(query string) bool {
			return strings.HasPrefix(query, "ROLLBACK TO SAVEPOINT") || strings.HasPrefix(query, "RELEASE SAVEPOINT")
		}})
		err := nested(func() error { return errors.New("callback failed") })
		wantBoth(t, "both statements", err, "callback failed", errStatementRejected.Error())
		if n := strings.Count(err.Error(), errStatementRejected.Error()); n != 2 {
			t.Fatalf("want both savepoint statements reported, got %d in %v", n, err)
		}
	})
}
