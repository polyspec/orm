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

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestWithContextCancels cancels the context of a connection handle while a
// statement is running: the statement returns CANCELED, and the connection the
// handle was derived from stays usable. The running statement is an update of
// the table that another connection holds (holdRows), so it waits for that
// lock until the context is cancelled once the server reports the statement
// waiting for the lock. SQLite waits for a lock in its busy handler, which a
// cancelled context does not interrupt, so on SQLite the context is cancelled
// before the statement and the statement does not start. TestWithContextCancelsMariadb
// is the case on MariaDB, a server of the MySQL dialect (DIA-200), which make
// mariadb-recipes-check/go runs.
// Requirements: CFG-9.
func TestWithContextCancels(t *testing.T) {
	withContextCancels(t, "sqlite", "mysql", "postgres")
}

// Requirements: CFG-9.
func TestWithContextCancelsMariadb(t *testing.T) { withContextCancels(t, "mariadb") }

func withContextCancels(t *testing.T, drivers ...string) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "zone")
	eachDatabase(t, drivers, s, 1, func(t *testing.T, driver, dsn string, db *orm.DB) {
		ent := zoneEntity(s)
		createZoneRowAt(t, db, ent, time.Now().UTC().Format("2006-01-02 15:04:05.000000"))
		// The row is read before the table is held: on MySQL and MariaDB holdRows holds the whole table.
		blocked := orm.NewCore(ent)
		ent.New(blocked)
		blocked.Connect(db)
		got, err := blocked.Get()
		if err != nil {
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
			defer testcase.Close(t, monitor)
			before, err := waiters(monitor, driver)
			if err != nil {
				t.Fatal(err)
			}
			go func() {
				waiting <- awaitLockWait(ctx, monitor, driver, before)
				cancel()
			}()
		}
		got.Orm_().Connect(db.WithContext(ctx))
		got.Orm_().Set("start_dt", time.Now().UTC().Format("2006-01-02 15:04:05.000000"))
		started := time.Now()
		if err := got.Orm_().Update(nil); orm.ErrorCode(err) != orm.CodeCanceled {
			t.Fatalf("cancelled statement: %v (code %q)", err, orm.ErrorCode(err))
		}
		// The statement returned CANCELED while the other connection still held the rows (release runs at the end
		// of the case), so the cancellation ended it, not a released lock; its duration is printed, not judged.
		t.Logf("the cancelled statement returned after %s", time.Since(started))
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

// holdRows holds the table on another connection, so that a statement that writes or locks its rows waits. On MySQL and
// MariaDB the connection takes LOCK TABLES ... WRITE, whose metadata lock a waiting statement lists as PENDING in
// performance_schema.metadata_locks, which both servers keep live (lockWaiters); on PostgreSQL and SQLite it updates every
// row of the table in an open transaction (SQLite takes the database write lock). The returned function releases the
// table, and a second call does nothing. It is also called when the test ends.
func holdRows(t *testing.T, driver, dsn, table string) func() {
	t.Helper()
	native := openNative(t, driver, dsn)
	ctx := context.Background()
	conn, err := native.Conn(ctx)
	if err != nil {
		t.Fatal(errors.Join(err, native.Close()))
	}
	hold, unhold := `BEGIN`, `ROLLBACK`
	statement := `UPDATE "` + table + `" SET "seq" = "seq"`
	if mysqlFamily(driver) {
		hold, statement, unhold = "", "LOCK TABLES `"+table+"` WRITE", "UNLOCK TABLES"
	}
	for _, sql := range []string{hold, statement} {
		if sql == "" {
			continue
		}
		if _, err := conn.ExecContext(ctx, sql); err != nil {
			t.Fatal(errors.Join(err, conn.Close(), native.Close()))
		}
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			if _, err := conn.ExecContext(ctx, unhold); err != nil {
				t.Errorf("release the held table: %v", err)
			}
			testcase.Close(t, conn)
			testcase.Close(t, native)
		})
	}
	t.Cleanup(release)
	return release
}

// mysqlFamily reports whether driver names a server of the MySQL dialect: MySQL or MariaDB (DIA-200).
func mysqlFamily(driver string) bool { return driver == "mysql" || driver == "mariadb" }

// TestWithContextCancelsTransaction cancels a transaction started on a context
// handle: the transaction fails with CANCELED and its writes are rolled back.
// TestWithContextCancelsTransactionMariadb is the case on MariaDB (DIA-200).
// Requirements: INT-67.
func TestWithContextCancelsTransaction(t *testing.T) {
	withContextCancelsTransaction(t, "sqlite", "mysql", "postgres")
}

// Requirements: INT-67.
func TestWithContextCancelsTransactionMariadb(t *testing.T) {
	withContextCancelsTransaction(t, "mariadb")
}

func withContextCancelsTransaction(t *testing.T, drivers ...string) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "zone")
	eachDatabase(t, drivers, s, 1, func(t *testing.T, driver, dsn string, db *orm.DB) {
		ent := zoneEntity(s)
		ctx, cancel := context.WithCancel(context.Background())
		handle := db.WithContext(ctx)
		err := handle.Transaction(func() error {
			row := orm.NewCore(ent)
			ent.New(row)
			row.Connect(handle)
			row.Set("start_dt", time.Now().UTC().Format("2006-01-02 15:04:05.000000"))
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

// TestWithContextCancelsInsideTransaction waits inside a transaction for a table
// another connection holds (holdRows), and cancels the handle's context: the
// statement returns CANCELED instead of waiting for the lock. On MySQL and
// MariaDB the driver closes the connection and the transaction reports ROLLBACK
// with the cancellation cause; PostgreSQL sends a protocol cancel request and
// reports CANCELED. TestWithContextCancelsInsideTransactionMariadb is the case on
// MariaDB (DIA-200).
func TestWithContextCancelsInsideTransaction(t *testing.T) {
	withContextCancelsInsideTransaction(t, "mysql", "postgres")
}

func TestWithContextCancelsInsideTransactionMariadb(t *testing.T) {
	withContextCancelsInsideTransaction(t, "mariadb")
}

func withContextCancelsInsideTransaction(t *testing.T, drivers ...string) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "zone")
	manifest := s
	for _, driver := range drivers {
		t.Run(driver, func(t *testing.T) {
			dsn := newDatabase(t, driver)
			holder, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, holder)
			waiter, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, waiter)
			monitor := openNative(t, driver, serverSession(t, driver, dsn))
			defer testcase.Close(t, monitor)
			if err := holder.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			ent := zoneEntity(s)
			seed := orm.NewCore(ent)
			ent.New(seed)
			seed.Connect(holder)
			seed.Set("start_dt", time.Now().UTC().Format("2006-01-02 15:04:05.000000"))
			if _, err := seed.Create(); err != nil {
				t.Fatal(err)
			}
			for _, nested := range []bool{false, true} {
				t.Run(fmt.Sprintf("nested=%v", nested), func(t *testing.T) {
					release := holdRows(t, driver, dsn, "zone_event")
					defer release()
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
					// In a nested transaction, the canceled statement runs inside a savepoint.
					err := waiter.Transaction(func() error {
						if nested {
							return waiter.Transaction(read)
						}
						return read()
					})
					waited := time.Since(start)
					release()
					if waitErr := <-waiting; waitErr != nil {
						t.Fatal(waitErr)
					}
					want := orm.CodeCanceled
					if mysqlFamily(driver) {
						want = orm.CodeRollback
					}
					if orm.ErrorCode(err) != want {
						t.Fatalf("blocked read: %v (code %q), want %s", err, orm.ErrorCode(err), want)
					}
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("blocked read does not keep the cancellation: %v", err)
					}
					// The read returned while the holder still held the table (release runs after it), so the cancellation
					// ended it; its duration is printed, not judged.
					t.Logf("the cancelled read returned after %s", waited)
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
	db := connectSchemaDB(t, "sqlite://"+filepath.Join(t.TempDir(), "root.sqlite"), s)
	defer testcase.Close(t, db)
	first := db.WithContext(context.Background())
	second := first.WithContext(context.Background())
	if db.Root() != db || first.Root() != db || second.Root() != db {
		t.Fatal("a derived handle reports another connection")
	}
	other, err := orm.ConnectSchema("sqlite://"+filepath.Join(t.TempDir(), "other.sqlite"), s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, other)
	if other.Root() == db.Root() {
		t.Fatal("two connections report the same root")
	}
}

// mysqlLockWaiters lists the sessions that wait for a table of the case database, one form on MySQL and MariaDB
// (DIA-200, rule 1): the pending metadata locks of performance_schema.metadata_locks, which both servers keep live, as the
// recipe runners read a lock holder (MariaDB has no performance_schema.data_locks, and information_schema.INNODB_TRX is
// a cache that concurrent readers keep from refreshing).
const mysqlLockWaiters = "SELECT DISTINCT t.PROCESSLIST_ID FROM performance_schema.metadata_locks m JOIN performance_schema.threads t ON t.THREAD_ID = m.OWNER_THREAD_ID WHERE m.OBJECT_TYPE = 'TABLE' AND m.OBJECT_SCHEMA = DATABASE() AND m.LOCK_STATUS = 'PENDING'"

// lockWaiters lists the sessions of the case database that wait for a lock.
var lockWaiters = map[string]string{
	"mysql":    mysqlLockWaiters,
	"mariadb":  mysqlLockWaiters,
	"postgres": "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
}

// waiters reads the sessions of the case database that wait for a lock now.
func waiters(monitor *sql.DB, driver string) (_ []int64, err error) {
	rows, err := monitor.Query(lockWaiters[driver])
	if err != nil {
		return nil, fmt.Errorf("lock wait query: %w", err)
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
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
