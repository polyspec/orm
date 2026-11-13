package orm_test

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

var zoneColumns = []string{"seq", "start_dt", "created_ts"}

func zoneEntity(s *orm.Schema) *orm.Entity {
	return rowEntity("zone_event", s, zoneColumns...)
}

// TestPoolSize applies the configured maximum of open connections and 10 when
// PoolSize is zero on SQLite, where the Go pool holds several connections as no
// other runtime's does; the recipe connection_pool states MySQL and PostgreSQL.
// Requirements: CFG-4.
func TestPoolSize(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := "sqlite://" + filepath.Join(t.TempDir(), "pool.sqlite")
	s := fixtureSchema(t, "zone")
	db, err := orm.ConnectSchema(dsn, s, orm.Config{PoolSize: 3})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	if got := db.Stats().MaxOpenConnections; got != 3 {
		t.Fatalf("max open connections = %d, want 3", got)
	}
	unset, err := orm.ConnectSchema(dsn, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, unset)
	if got := unset.Stats().MaxOpenConnections; got != 10 {
		t.Fatalf("max open connections without a pool size = %d, want 10", got)
	}
}

// TestPoolIdleSize keeps at most PoolIdleSize idle connections on SQLite, where
// the Go pool holds several connections as no other runtime's does (the recipe
// connection_pool states MySQL and PostgreSQL, and the recipes connection_pool and
// dsn_reject_checked hold the refused values).
// Requirements: CFG-5.
func TestPoolIdleSize(t *testing.T) {
	testcase.Start(t, testcase.Database)
	targets := map[string]string{
		"sqlite": "sqlite://" + filepath.Join(t.TempDir(), "pool-idle.sqlite"),
	}
	s := fixtureSchema(t, "zone")
	for driver, dsn := range targets {
		t.Run(driver, func(t *testing.T) {
			requireTarget(t, driver, dsn)
			// Three read-only transactions hold three connections at once,
			// and SQLite begins them without the write lock; after they end
			// the pool keeps one idle connection and closes the others.
			idle, err := orm.ConnectSchema(dsn, s, orm.Config{PoolSize: 3, PoolIdleSize: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, idle)
			var started, release sync.WaitGroup
			started.Add(3)
			release.Add(1)
			var wg sync.WaitGroup
			for i := 0; i < 3; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					err := idle.Transaction(func() error {
						started.Done()
						release.Wait()
						return nil
					}, orm.ReadOnly())
					if err != nil {
						t.Error(err)
					}
				}()
			}
			started.Wait()
			if open := idle.Stats().OpenConnections; open != 3 {
				t.Errorf("three transactions hold %d connections", open)
			}
			release.Done()
			wg.Wait()
			if st := idle.Stats(); st.Idle != 1 || st.OpenConnections != 1 {
				t.Fatalf("pool idle size 1 keeps %d idle of %d open connections", st.Idle, st.OpenConnections)
			}
			unset, err := orm.ConnectSchema(dsn, s, orm.Config{PoolSize: 3})
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, unset)
			started.Add(3)
			release.Add(1)
			for i := 0; i < 3; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					if err := unset.Transaction(func() error { started.Done(); release.Wait(); return nil }, orm.ReadOnly()); err != nil {
						t.Error(err)
					}
				}()
			}
			started.Wait()
			release.Done()
			wg.Wait()
			if st := unset.Stats(); st.Idle != 3 {
				t.Fatalf("pool idle size unset keeps %d idle connections, want the pool size 3", st.Idle)
			}
		})
	}
}

// TestPoolLifetime closes a connection PoolLifetimeMs after it was opened: the
// expiry takes the time of the pool's cleanup, which no recipe value states.
// Requirements: CFG-5.
func TestPoolLifetime(t *testing.T) {
	testcase.Start(t, testcase.Database)
	targets := map[string]string{
		"sqlite": "sqlite://" + filepath.Join(t.TempDir(), "pool-lifetime.sqlite"),
	}
	s := fixtureSchema(t, "zone")
	for driver, dsn := range targets {
		t.Run(driver, func(t *testing.T) {
			requireTarget(t, driver, dsn)
			// The pool closes an idle connection whose lifetime has passed
			// on its next cleanup, which runs at least once a second.
			aged, err := orm.ConnectSchema(dsn, s, orm.Config{PoolLifetimeMs: 100})
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, aged)
			if err := aged.Transaction(func() error { return nil }); err != nil {
				t.Fatal(err)
			}
			time.Sleep(2 * time.Second)
			if open := aged.Stats().OpenConnections; open != 0 {
				t.Fatalf("pool lifetime 100 ms keeps %d connections open after 2 s", open)
			}
		})
	}
}

// TestPoolDiscardsEndedIdleConnection keeps the process alive after a server
// ends the sole idle connection, then verifies the next statement succeeds.
// Requirements: INT-92.
func TestPoolDiscardsEndedIdleConnection(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, driver := range []string{"mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			caseDSN := newDatabase(t, driver)
			// The case ends a server-side session, so both handles must bypass
			// any transaction or multiplexing proxy.
			dsn := serverSession(t, driver, caseDSN)
			db, err := orm.Connect(dsn, orm.Config{PoolSize: 1, PoolIdleSize: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, db)
			if _, err := db.Utils().Schema().Exists("orm"); err != nil {
				t.Fatalf("warm pool connection: %v", err)
			}
			if stats := db.Stats(); stats.Idle != 1 {
				t.Fatalf("pool before server end: %+v, want one idle connection", stats)
			}

			admin := openNative(t, driver, dsn)
			defer testcase.Close(t, admin)
			var killed int
			switch driver {
			case "postgres":
				rows, err := admin.Query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`)
				if err != nil {
					t.Fatal(err)
				}
				var pids []int64
				for rows.Next() {
					var pid int64
					if err := rows.Scan(&pid); err != nil {
						t.Fatal(err)
					}
					pids = append(pids, pid)
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				if err := rows.Close(); err != nil {
					t.Fatal(err)
				}
				if len(pids) != 1 {
					t.Fatalf("case database has %d other server sessions, want the one idle pool connection", len(pids))
				}
				var ended bool
				if err := admin.QueryRow(`SELECT pg_terminate_backend($1, 5000)`, pids[0]).Scan(&ended); err != nil {
					t.Fatalf("end idle PostgreSQL session: %v", err)
				}
				if !ended {
					t.Fatal("PostgreSQL did not end the idle pool connection")
				}
				killed = 1
			case "mysql":
				rows, err := admin.Query(`SELECT ID FROM information_schema.PROCESSLIST WHERE DB = DATABASE() AND ID <> CONNECTION_ID()`)
				if err != nil {
					t.Fatal(err)
				}
				var ids []int64
				for rows.Next() {
					var id int64
					if err := rows.Scan(&id); err != nil {
						t.Fatal(err)
					}
					ids = append(ids, id)
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				if err := rows.Close(); err != nil {
					t.Fatal(err)
				}
				if len(ids) != 1 {
					t.Fatalf("case database has %d other server sessions, want the one idle pool connection", len(ids))
				}
				if _, err := admin.Exec("KILL ?", ids[0]); err != nil {
					t.Fatalf("end idle MySQL session: %v", err)
				}
				deadline := time.Now().Add(10 * time.Second)
				for {
					var remaining int
					if err := admin.QueryRow(`SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID = ?`, ids[0]).Scan(&remaining); err != nil {
						t.Fatal(err)
					}
					if remaining == 0 {
						break
					}
					if time.Now().After(deadline) {
						t.Fatalf("server still lists idle session %d after KILL", ids[0])
					}
					time.Sleep(20 * time.Millisecond)
				}
				killed = 1
			}
			if killed != 1 {
				t.Fatalf("ended %d idle pool sessions, want one", killed)
			}
			if driver == "postgres" {
				// pgx's native stdlib ResetSession pings after a connection has been idle for more than one second.
				time.Sleep(1100 * time.Millisecond)
			}
			if _, err := db.Utils().Schema().Exists("orm"); err != nil {
				t.Fatalf("statement after server ended idle connection: %v", err)
			}
			if stats := db.Stats(); stats.Idle != 1 {
				t.Fatalf("pool after replacement connection: %+v, want one idle connection", stats)
			}
		})
	}
}

// TestNativeTimeIsRefusedByDatetime checks that a native time.Time is no value of a datetime column: the
// setter takes the text form only, so the write is refused with CODEC_ENCODE.
// Requirements: DBS-121.
func TestNativeTimeIsRefusedByDatetime(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "zone")
	dsn := newDatabase(t, "sqlite")
	db := connectSchemaDB(t, dsn, s)
	defer testcase.Close(t, db)
	if err := db.Utils().Schema().Install(s); err != nil {
		t.Fatal(err)
	}
	ent := zoneEntity(s)
	c := orm.NewCore(ent)
	ent.New(c)
	c.Connect(db)
	c.Set("start_dt", time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC))
	if _, err := c.Create(); orm.ErrorCode(err) != "CODEC_ENCODE" {
		t.Fatalf("native time.Time: want CODEC_ENCODE, got %v", err)
	}
}
