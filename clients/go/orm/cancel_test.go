package orm_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

// TestWithContextCancels cancels the context of a connection handle while a
// statement is running: the statement returns CANCELED, and the connection the
// handle was derived from stays usable. The running statement is an update of
// a row that another connection holds in an open transaction, so it waits for
// that lock until the context is cancelled once the server reports the
// statement waiting for the lock. SQLite waits for a lock in its busy handler,
// which a cancelled context does not interrupt, so on SQLite the context is
// cancelled before the statement and the statement does not start.
func TestWithContextCancels(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "zone")
	manifest := s
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			dsn := newDatabase(t, driver)
			db, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			ent := zoneEntity(s)
			row := orm.NewCore(ent)
			ent.New(row)
			row.Connect(db)
			row.Set("start_dt", time.Now())
			if _, err := row.Create(); err != nil {
				t.Fatal(err)
			}
			release := holdRows(t, driver, dsn, "zone_event")
			defer release()

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			waiting := make(chan error, 1)
			if driver == "sqlite" {
				cancel()
				waiting <- nil
			} else {
				monitor := openNative(t, driver, serverSession(t, driver, dsn))
				defer monitor.Close()
				before, err := waiters(monitor, driver)
				if err != nil {
					t.Fatal(err)
				}
				go func() {
					waiting <- awaitLockWait(ctx, monitor, driver, before)
					cancel()
				}()
			}
			blocked := orm.NewCore(ent)
			ent.New(blocked)
			blocked.Connect(db)
			got, err := blocked.Get()
			if err != nil {
				t.Fatal(err)
			}
			got.Orm_().Connect(db.WithContext(ctx))
			got.Orm_().Set("start_dt", time.Now())
			started := time.Now()
			if err := got.Orm_().Update(nil); orm.ErrorCode(err) != orm.CodeCanceled {
				t.Fatalf("cancelled statement: %v (code %q)", err, orm.ErrorCode(err))
			}
			if took := time.Since(started); took > 4*time.Second {
				t.Fatalf("cancellation waited for the statement: %s", took)
			}
			if err := <-waiting; err != nil {
				t.Fatal(err)
			}
			release()

			// The connection is usable after the cancelled statement.
			after := orm.NewCore(ent)
			ent.New(after)
			after.Connect(db)
			if n, err := after.GetCount(); err != nil || n != 1 {
				t.Fatalf("count after cancellation: %d %v", n, err)
			}
		})
	}
}

// holdRows는 다른 연결의 열린 transaction에서 table의 모든 행을 갱신해 그 행의 lock(SQLite는
// database write lock)을 잡는다. 돌려준 함수는 그 transaction을 rollback하고 두 번째 호출은
// 아무것도 하지 않는다. test가 끝날 때도 부른다.
func holdRows(t *testing.T, driver, dsn, table string) func() {
	t.Helper()
	native := openNative(t, driver, dsn)
	tx, err := native.Begin()
	if err != nil {
		native.Close()
		t.Fatal(err)
	}
	quote := func(name string) string { return `"` + name + `"` }
	if driver == "mysql" {
		quote = func(name string) string { return "`" + name + "`" }
	}
	if _, err := tx.Exec("UPDATE " + quote(table) + " SET " + quote("seq") + " = " + quote("seq")); err != nil {
		tx.Rollback()
		native.Close()
		t.Fatal(err)
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			if err := tx.Rollback(); err != nil {
				t.Errorf("release the held rows: %v", err)
			}
			native.Close()
		})
	}
	t.Cleanup(release)
	return release
}

// TestWithContextCancelsTransaction cancels a transaction started on a context
// handle: the transaction fails with CANCELED and its writes are rolled back.
func TestWithContextCancelsTransaction(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "zone")
	manifest := s
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			dsn := newDatabase(t, driver)
			db, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			ent := zoneEntity(s)
			ctx, cancel := context.WithCancel(context.Background())
			handle := db.WithContext(ctx)
			err = handle.Transaction(func() error {
				row := orm.NewCore(ent)
				ent.New(row)
				row.Connect(handle)
				row.Set("start_dt", time.Now())
				if _, err := row.Create(); err != nil {
					return err
				}
				cancel()
				return nil
			})
			if orm.ErrorCode(err) != orm.CodeCanceled {
				t.Fatalf("cancelled transaction: %v (code %q)", err, orm.ErrorCode(err))
			}
			after := orm.NewCore(ent)
			ent.New(after)
			after.Connect(db)
			if n, err := after.GetCount(); err != nil || n != 0 {
				t.Fatalf("rows after a cancelled transaction: %d %v", n, err)
			}
		})
	}
}

// TestWithContextCancelsInsideTransaction waits inside a transaction for a row
// another connection holds, and cancels the handle's context: the statement
// returns CANCELED instead of waiting for the lock. MySQL과 PostgreSQL에서는
// driver가 취소된 statement의 connection을 닫으므로 transaction은 취소를
// 유지한 ROLLBACK을 보고한다.
func TestWithContextCancelsInsideTransaction(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "zone")
	manifest := s
	for _, driver := range []string{"mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			dsn := newDatabase(t, driver)
			holder, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Close()
			waiter, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer waiter.Close()
			monitor := openNative(t, driver, serverSession(t, driver, dsn))
			defer monitor.Close()
			if err := holder.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			ent := zoneEntity(s)
			seed := orm.NewCore(ent)
			ent.New(seed)
			seed.Connect(holder)
			seed.Set("start_dt", time.Now())
			if _, err := seed.Create(); err != nil {
				t.Fatal(err)
			}
			for _, nested := range []bool{false, true} {
				t.Run(fmt.Sprintf("nested=%v", nested), func(t *testing.T) {
					held := make(chan struct{})
					release := make(chan struct{})
					done := make(chan error, 1)
					go func() {
						done <- holder.Transaction(func() error {
							locked := orm.NewCore(ent)
							ent.New(locked)
							locked.Connect(holder)
							locked.Lock("update")
							if _, err := locked.Get(); err != nil {
								return err
							}
							close(held)
							<-release
							return nil
						})
					}()
					// holder가 row를 잡기 전에 끝나면 held는 닫히지 않으므로 그 결과를 보고한다.
					select {
					case <-held:
					case holderErr := <-done:
						t.Fatalf("the holder transaction ended before it held the row: %v", holderErr)
					}
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					// The context is cancelled once the server reports the statement
					// waiting for the lock; a timer could fire before the statement
					// starts, and then no statement is cancelled.
					waiting := make(chan error, 1)
					// Sessions that wait already, such as the cancelled statement of the case before, are not this
					// case's statement.
					before, waitersErr := waiters(monitor, driver)
					if waitersErr != nil {
						t.Fatal(waitersErr)
					}
					go func() {
						waiting <- awaitLockWait(ctx, monitor, driver, before)
						cancel()
					}()
					start := time.Now()
					// The transaction is opened on the connection, and the statement
					// inside it runs on a handle carrying the caller's context.
					read := func() error {
						blocked := orm.NewCore(ent)
						ent.New(blocked)
						blocked.Connect(waiter.WithContext(ctx))
						blocked.Lock("update")
						_, err := blocked.Get()
						return err
					}
					// 중첩 transaction에서는 취소된 statement가 savepoint 안에서 실행된다.
					err := waiter.Transaction(func() error {
						if nested {
							return waiter.Transaction(read)
						}
						return read()
					})
					waited := time.Since(start)
					close(release)
					if waitErr := <-waiting; waitErr != nil {
						t.Fatal(waitErr)
					}
					if holderErr := <-done; holderErr != nil {
						t.Fatal(holderErr)
					}
					// MySQL과 PostgreSQL driver는 취소된 statement의 connection을 닫으므로
					// transaction의 rollback이 실패하고 client는 두 오류를 함께 보고한다.
					want := orm.CodeCanceled
					if driver != "sqlite" {
						want = orm.CodeRollback
					}
					if orm.ErrorCode(err) != want {
						t.Fatalf("blocked read: %v (code %q), want %s", err, orm.ErrorCode(err), want)
					}
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("blocked read does not keep the cancellation: %v", err)
					}
					if waited > 10*time.Second {
						t.Fatalf("cancel took %s", waited)
					}
				})
			}
		})
	}
}

// TestRootIdentifiesTheConnection checks that handles derived from one
// connection report the same connection, so callers can compare them.
func TestRootIdentifiesTheConnection(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "zone")
	db, err := orm.ConnectSchema("sqlite://"+filepath.Join(t.TempDir(), "root.sqlite"), s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	first := db.WithContext(context.Background())
	second := first.WithContext(context.Background())
	if db.Root() != db || first.Root() != db || second.Root() != db {
		t.Fatal("a derived handle reports another connection")
	}
	other, err := orm.ConnectSchema("sqlite://"+filepath.Join(t.TempDir(), "other.sqlite"), s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if other.Root() == db.Root() {
		t.Fatal("two connections report the same root")
	}
}

// lockWaiters lists the sessions of the case database that wait for a lock.
var lockWaiters = map[string]string{
	"mysql":    "SELECT DISTINCT THREAD_ID FROM performance_schema.data_locks WHERE OBJECT_SCHEMA = DATABASE() AND LOCK_STATUS = 'WAITING'",
	"postgres": "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
}

// waiters reads the sessions of the case database that wait for a lock now.
func waiters(monitor *sql.DB, driver string) ([]int64, error) {
	rows, err := monitor.Query(lockWaiters[driver])
	if err != nil {
		return nil, fmt.Errorf("lock wait query: %w", err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// newWaiter reports whether a session waits now that did not wait before. A statement that an earlier case
// cancelled can still wait on the server after its connection closed, until the lock is released; counting
// it as the statement of this case cancels this case's context before its statement starts.
func newWaiter(before, now []int64) bool {
	for _, id := range now {
		if !slices.Contains(before, id) {
			return true
		}
	}
	return false
}

// awaitLockWait returns when a session of the case database that did not wait at before (from waiters) waits
// for a lock. It returns an error when ctx ends first or no such session waits within 10 seconds.
func awaitLockWait(ctx context.Context, monitor *sql.DB, driver string, before []int64) error {
	deadline := time.Now().Add(10 * time.Second)
	for {
		now, err := waiters(monitor, driver)
		if err != nil {
			return err
		}
		if newWaiter(before, now) {
			return nil
		}
		if ctx.Err() != nil {
			return fmt.Errorf("the context ended before a statement waited for the lock: %w", ctx.Err())
		}
		if time.Now().After(deadline) {
			return errors.New("no statement waited for the lock within 10s")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestNewWaiterIgnoresSessionsThatAlreadyWaited pins the race that cancelled the context of a case before its
// statement ran: a session left waiting by an earlier case is not the statement of this case.
func TestNewWaiterIgnoresSessionsThatAlreadyWaited(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	if newWaiter([]int64{7}, []int64{7}) {
		t.Fatal("a session that waited before counts as the statement of this case")
	}
	if newWaiter(nil, nil) {
		t.Fatal("no session waits, yet a waiter was found")
	}
	if !newWaiter([]int64{7}, []int64{7, 9}) || !newWaiter(nil, []int64{3}) {
		t.Fatal("a session that started to wait was not found")
	}
}
