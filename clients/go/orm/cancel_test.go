package orm_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

// TestWithContextCancels cancels the context of a connection handle while a
// statement is running: the statement returns CANCELED, and the connection the
// handle was derived from stays usable.
func TestWithContextCancels(t *testing.T) {
	slow := map[string]string{
		"mysql":    "SLEEP(5) = 0",
		"postgres": "pg_sleep(5) IS NULL",
		"sqlite":   "(SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000000) SELECT x FROM c)) >= 0",
	}
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "cancel.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	d, err := schema.Parse(zoneSchema)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	for driver, dsn := range targets {
		if dsn == "" {
			continue
		}
		t.Run(driver, func(t *testing.T) {
			dropTable(t, driver, dsn, "zone_event")
			defer dropTable(t, driver, dsn, "zone_event")
			eng, err := engine.New(m, driver)
			if err != nil {
				t.Fatal(err)
			}
			db, err := orm.Open(dsn, eng, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			ent := zoneEntity(m.SchemaHash)
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
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "cancel-tx.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	d, err := schema.Parse(zoneSchema)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	for driver, dsn := range targets {
		if dsn == "" {
			continue
		}
		t.Run(driver, func(t *testing.T) {
			dropTable(t, driver, dsn, "zone_event")
			defer dropTable(t, driver, dsn, "zone_event")
			eng, err := engine.New(m, driver)
			if err != nil {
				t.Fatal(err)
			}
			db, err := orm.Open(dsn, eng, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			ent := zoneEntity(m.SchemaHash)
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
// returns CANCELED instead of waiting for the lock.
func TestWithContextCancelsInsideTransaction(t *testing.T) {
	targets := map[string]string{
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	d, err := schema.Parse(zoneSchema)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	for driver, dsn := range targets {
		if dsn == "" {
			continue
		}
		t.Run(driver, func(t *testing.T) {
			dropTable(t, driver, dsn, "zone_event")
			defer dropTable(t, driver, dsn, "zone_event")
			eng, err := engine.New(m, driver)
			if err != nil {
				t.Fatal(err)
			}
			holder, err := orm.Open(dsn, eng, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Close()
			waiter, err := orm.Open(dsn, eng, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer waiter.Close()
			if err := holder.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			ent := zoneEntity(m.SchemaHash)
			seed := orm.NewCore(ent)
			ent.New(seed)
			seed.Connect(holder)
			seed.Set("start_dt", time.Now())
			if _, err := seed.Create(); err != nil {
				t.Fatal(err)
			}
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
			<-held
			ctx, cancel := context.WithCancel(context.Background())
			go func() {
				time.Sleep(300 * time.Millisecond)
				cancel()
			}()
			start := time.Now()
			// The transaction is opened on the connection, and the statement
			// inside it runs on a handle carrying the caller's context.
			err = waiter.Transaction(func() error {
				blocked := orm.NewCore(ent)
				ent.New(blocked)
				blocked.Connect(waiter.WithContext(ctx))
				blocked.Lock("update")
				_, err := blocked.Get()
				return err
			})
			waited := time.Since(start)
			close(release)
			if holderErr := <-done; holderErr != nil {
				t.Fatal(holderErr)
			}
			if orm.ErrorCode(err) != orm.CodeCanceled {
				t.Fatalf("blocked read: %v (code %q)", err, orm.ErrorCode(err))
			}
			if waited > 10*time.Second {
				t.Fatalf("cancel took %s", waited)
			}
		})
	}
}

// TestRootIdentifiesTheConnection checks that handles derived from one
// connection report the same connection, so callers can compare them.
func TestRootIdentifiesTheConnection(t *testing.T) {
	d, err := schema.Parse(zoneSchema)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	eng, err := engine.New(m, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	db, err := orm.Open("sqlite://"+filepath.Join(t.TempDir(), "root.sqlite"), eng, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	first := db.WithContext(context.Background())
	second := first.WithContext(context.Background())
	if db.Root() != db || first.Root() != db || second.Root() != db {
		t.Fatal("a derived handle reports another connection")
	}
	other, err := orm.Open("sqlite://"+filepath.Join(t.TempDir(), "other.sqlite"), eng, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if other.Root() == db.Root() {
		t.Fatal("two connections report the same root")
	}
}
