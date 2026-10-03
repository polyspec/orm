package orm_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

// TestWithContextCancels cancels the context of a connection handle while a
// statement is running: the statement returns CANCELED, and the connection the
// handle was derived from stays usable.
func TestWithContextCancels(t *testing.T) {
	testcase.Start(t, testcase.Database)
	slow := map[string]string{
		"mysql":    "SLEEP(5) = 0",
		"postgres": "pg_sleep(5) IS NULL",
		"sqlite":   "(SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000000) SELECT x FROM c)) >= 0",
	}
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

			ctx, cancel := context.WithCancel(context.Background())
			handle := db.WithContext(ctx)
			go func() {
				time.Sleep(300 * time.Millisecond)
				cancel()
			}()
			c := orm.NewCore(ent)
			ent.New(c)
			c.Connect(handle)
			c.Raw("", slow[driver], nil)
			started := time.Now()
			if _, err := c.GetCount(); orm.ErrorCode(err) != orm.CodeCanceled {
				t.Fatalf("cancelled statement: %v (code %q)", err, orm.ErrorCode(err))
			}
			if took := time.Since(started); took > 4*time.Second {
				t.Fatalf("cancellation waited for the statement: %s", took)
			}

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
					go func() {
						time.Sleep(300 * time.Millisecond)
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
