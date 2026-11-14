package orm_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestWithContextCancels cancels the context of a connection handle while a
// statement is running: the statement returns CANCELED, and the connection the
// handle was derived from stays usable. The running statement is an update of
// the table that another connection holds (holdRows), so it waits for that
// lock until the context is cancelled. The cancellation follows an event of the
// database (T475): on PostgreSQL the start of the update (statementStarts), on
// SQLite the sleep of the update in the busy handler of its connection, which
// synctest.Wait reports in a synctest bubble. MySQL and MariaDB send no event
// when a statement starts or waits, so there the cancellation follows the lock
// wait timeout that the server returns to a probe session (lockProbe). The holder
// keeps the lock until the statement has returned, so a statement that returns
// CANCELED ended because of the cancellation. TestWithContextCancelsMariadb is
// the case on MariaDB, a server of the MySQL dialect (DIA-200), which make
// mariadb-recipes-check/go runs.
// Requirements: CFG-9.
func TestWithContextCancels(t *testing.T) {
	testcase.Start(t)
	withContextCancels(t, "mysql", "postgres")
	t.Run("sqlite", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			s := fixtureSchema(t, "zone")
			dsn := newDatabase(t, "sqlite")
			db := connectSchemaDB(t, dsn, s)
			defer testcase.Close(t, db)
			if err := db.Utils().Schema().Install(s); err != nil {
				t.Fatalf("install: %v", err)
			}
			cancelsWaitingUpdate(t, "sqlite", dsn, db, s)
		})
	})
}

// Requirements: CFG-9.
func TestWithContextCancelsMariadb(t *testing.T) {
	testcase.Start(t)
	withContextCancels(t, "mariadb")
}

func withContextCancels(t *testing.T, drivers ...string) {
	s := fixtureSchema(t, "zone")
	eachDatabase(t, drivers, s, 1, func(t *testing.T, driver, dsn string, db *orm.DB) {
		cancelsWaitingUpdate(t, driver, dsn, db, s)
	})
}

// cancelsWaitingUpdate is the body of TestWithContextCancels on one database; on SQLite it runs in a synctest bubble.
func cancelsWaitingUpdate(t *testing.T, driver, dsn string, db *orm.DB, s *orm.Schema) {
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
	// The trigger of statementStarts is installed before the holder holds the rows, and removed after it releases them.
	var starts *startEvent
	if driver == "postgres" {
		starts = statementStarts(t, serverSession(t, driver, dsn), "zone_event")
		defer starts.close(t)
	}
	release := holdRows(t, driver, dsn, "zone_event")
	defer release()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var started <-chan error
	var probe *lockProbe
	switch {
	case driver == "sqlite":
	case starts != nil:
		started = starts.arm(t)
	default:
		probe = openLockProbe(t, driver, serverSession(t, driver, dsn))
	}
	got.Orm_().Connect(db.WithContext(ctx))
	got.Orm_().Set("start_dt", time.Now().UTC().Format("2006-01-02 15:04:05.000000"))
	updated := make(chan error, 1)
	go func() { updated <- got.Orm_().Update(nil) }()
	waiting := make(chan error, 1)
	switch {
	case started != nil:
		waiting <- <-started
		cancel()
	case probe != nil:
		waiting <- probe.waits(`SELECT 1 FROM zone_event FOR UPDATE`)
		cancel()
	}
	if driver == "sqlite" {
		// Every other goroutine of the bubble is blocked: the update sleeps in the busy handler of its connection, since
		// the holder keeps the write lock, or it has returned, which the select reports.
		synctest.Wait()
		select {
		case err := <-updated:
			t.Fatalf("the SQLite update returned before it waited for the write lock: %v (code %q)", err, orm.ErrorCode(err))
		default:
		}
		cancel()
		waiting <- nil
	}
	if err := <-updated; orm.ErrorCode(err) != orm.CodeCanceled {
		t.Fatalf("cancelled statement: %v (code %q)", err, orm.ErrorCode(err))
	}
	if err := <-waiting; err != nil {
		t.Fatal(err)
	}
	// The statement returned CANCELED while the other connection still held the rows, so the cancellation ended it, not
	// a released lock.
	release()

	// The connection is usable after the cancelled statement.
	after := orm.NewCore(ent)
	ent.New(after)
	after.Connect(db)
	if n, err := after.GetCount(); err != nil || n != 1 {
		t.Fatalf("count after cancellation: %d %v", n, err)
	}
}

// holdRows holds the table on another connection, so that a statement that writes or locks its rows waits. On MySQL and
// MariaDB the connection takes LOCK TABLES ... WRITE, whose metadata lock a statement of the table waits for, as the
// statement of a lockProbe does until its lock_wait_timeout; on PostgreSQL and SQLite it updates every
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
	testcase.Start(t)
	withContextCancelsTransaction(t, "sqlite", "mysql", "postgres")
}

// Requirements: INT-67.
func TestWithContextCancelsTransactionMariadb(t *testing.T) {
	testcase.Start(t)
	withContextCancelsTransaction(t, "mariadb")
}

func withContextCancelsTransaction(t *testing.T, drivers ...string) {
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
	testcase.Start(t)
	withContextCancelsInsideTransaction(t, "mysql", "postgres")
}

func TestWithContextCancelsInsideTransactionMariadb(t *testing.T) {
	testcase.Start(t)
	withContextCancelsInsideTransaction(t, "mariadb")
}

func withContextCancelsInsideTransaction(t *testing.T, drivers ...string) {
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
					// The statement is a SELECT ... FOR UPDATE of a client session, which fires no trigger and gives the
					// test no event when it waits, so the context is cancelled after the server ends the wait of a probe
					// session with its lock wait timeout (lockProbe, T475); a timer could fire before the statement starts.
					probe := openLockProbe(t, driver, serverSession(t, driver, dsn))
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
					done := make(chan error, 1)
					go func() {
						done <- waiter.Transaction(func() error {
							if nested {
								return waiter.Transaction(read)
							}
							return read()
						})
					}()
					waitErr := probe.waits(`SELECT 1 FROM zone_event FOR UPDATE`)
					cancel()
					err := <-done
					waited := time.Since(start)
					release()
					if waitErr != nil {
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
	testcase.Start(t)
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
