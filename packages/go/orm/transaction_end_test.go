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

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

// connectBench connects to dsn with the manifest of contracts/fixtures/bench/bench.dbs.
func connectBench(t *testing.T, dsn string) *DB {
	t.Helper()
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "contracts", "fixtures", "bench", "bench.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := ConnectSchema(dsn, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testcase.Close(t, db) })
	return db
}

// wantBoth checks that err is a ROLLBACK carrying both the callback error and the transaction end error
// together.
func wantBoth(t *testing.T, what string, err error, cause, end string) {
	t.Helper()
	want := fmt.Sprintf("transaction failed (%s) and rollback failed (", cause)
	if ErrorCode(err) != CodeRollback || !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), end) {
		t.Fatalf("%s: want ROLLBACK %q with %q, got %v", what, want, end, err)
	}
}

// recovered returns the panic value if fn panics or ends the goroutine.
func recovered(fn func()) (value any) {
	done := make(chan any, 1)
	go func() {
		defer func() { done <- recover() }()
		fn()
	}()
	return <-done
}

// TestTransactionReportsFailedLockRelease checks that when MySQL RELEASE_LOCK at the end of a transaction
// fails or cannot release the lock, commit and rollback return that error.
// That connection is not returned to the pool (TestFailedTransactionEndDiscardsConnection).
func TestTransactionReportsFailedLockRelease(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := os.Getenv("ORM_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers")
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
			// If the lock was released beforehand, RELEASE_LOCK at the end of the transaction returns 0.
			active, activeErr := activeFor(db)
			if activeErr != nil {
				return activeErr
			}
			_, err := active.conn.ExecContext(context.Background(), "DO RELEASE_LOCK(?)", key("released"))
			return err
		}, Retry(0))
		if want := "lock " + key("released") + " was not held at transaction end"; err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("want %q, got %v", want, err)
		}
	})
}

// TestFailedTransactionEndDiscardsConnection checks that when the cleanup at the end of a transaction (releasing the named lock, native rollback)
// fails, the connection is discarded rather than returned to the pool. The session's state after a failed cleanup cannot be known,
// so a connection returned to the pool is either clean or discarded. In a pool with one connection, the next use
// receives the same session (CONNECTION_ID) if the connection came back, and a named lock not released remains on that session.
func TestFailedTransactionEndDiscardsConnection(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := os.Getenv("ORM_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers")
	}
	useFailingDriver(t, "mysql")
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "contracts", "fixtures", "bench", "bench.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := ConnectSchema(dsn, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}, Config{PoolSize: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testcase.Close(t, db) })
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
	// free checks whether another connection can get the lock within 5 seconds. The server soon releases the lock of a finished session.
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

// TestTransactionReportsFailedRollback checks that when the native rollback fails, the callback
// error, a panic, a callback that has already ended, and a failed begin report that error together
// (checked).
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
			if err := db.Transaction(func() error { panic("callback panicked") }, Retry(0)); err != nil {
				t.Errorf("the panicking transaction returned %v", err)
			}
		})
		err, isErr := value.(error)
		if !isErr {
			t.Fatalf("the recovered value %v is not an error", value)
		}
		wantBoth(t, "panic", err, "callback panicked", errRollbackRejected.Error())
	})
	t.Run("goexit", func(t *testing.T) {
		inject(t, rollbackRejected)
		value := recovered(func() {
			if err := db.Transaction(func() error { runtime.Goexit(); return nil }, Retry(0)); err != nil {
				t.Errorf("the goexit transaction returned %v", err)
			}
		})
		err, isErr := value.(error)
		if !isErr {
			t.Fatalf("the recovered value %v is not an error", value)
		}
		wantBoth(t, "goexit", err, "callback exited without returning", errRollbackRejected.Error())
	})
	t.Run("begin", func(t *testing.T) {
		inject(t, injectedFailure{statement: func(query string) bool { return query == "PRAGMA query_only = 1" }, rollback: true})
		err := db.Transaction(func() error { return nil }, ReadOnly(), Retry(0))
		wantBoth(t, "begin", err, "DRIVER: "+errStatementRejected.Error(), errRollbackRejected.Error())
	})
	t.Run("panic with a successful rollback", func(t *testing.T) {
		value := recovered(func() {
			if err := db.Transaction(func() error { panic("callback panicked") }, Retry(0)); err != nil {
				t.Errorf("the panicking transaction returned %v", err)
			}
		})
		if value != "callback panicked" {
			t.Fatalf("want the callback's panic value, got %v", value)
		}
	})
}

// TestTransactionReportsFailedSQLiteModeReset checks that when the PRAGMA restoring the SQLite read-only mode
// fails, commit and rollback return that error. A query_only that could not be
// restored remains on the connection.
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

// TestSavepointReportsFailedEnd checks the savepoint end of a nested transaction:
// when ROLLBACK TO SAVEPOINT or RELEASE SAVEPOINT fails, the callback error, a panic,
// and an already ended callback report that error together, and that a successful callback returns
// the failed RELEASE SAVEPOINT.
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
			value := recovered(func() {
				if err := nested(func() error { panic("callback panicked") }); err != nil {
					t.Errorf("nested callback: %v", err)
				}
			})
			err, isErr := value.(error)
			if !isErr {
				t.Fatalf("the recovered value %v is not an error", value)
			}
			wantBoth(t, "panic", err, "callback panicked", errStatementRejected.Error())
		})
		t.Run(statement+"/goexit", func(t *testing.T) {
			inject(t, rejected(statement))
			value := recovered(func() {
				if err := nested(func() error { runtime.Goexit(); return nil }); err != nil {
					t.Errorf("nested goexit: %v", err)
				}
			})
			err, isErr := value.(error)
			if !isErr {
				t.Fatalf("the recovered value %v is not an error", value)
			}
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
