package orm_test

import (
	"crypto/rand"
	"database/sql"
	"testing"
	"time"

	"github.com/polyspec/orm/legacy/packages/go/engine/plan"
	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

var zoneColumns = []string{"seq", "start_dt", "created_ts"}

func zoneEntity(s *orm.Schema) *orm.Entity {
	return rowEntity("zone_event", s, zoneColumns...)
}

// TestPoolDiscardsEndedIdleConnection keeps the process alive after a server
// ends the sole idle connection, then verifies the next statement succeeds.
// Requirements: INT-92.
func TestPoolDiscardsEndedIdleConnection(t *testing.T) {
	testcase.Start(t)
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
			// On MySQL and MariaDB the idle connection holds a named lock, which its thread releases when it ends: KILL
			// returns before the killed thread has ended, and GET_LOCK of that lock, with a wait that the server limits,
			// answers when it has (T475). Execute runs DO GET_LOCK on the connection of the pool, which then returns to it.
			lock := "orm_int92_" + rand.Text()
			if driver == "mysql" {
				if err := db.Execute(&plan.Step{SQL: "DO GET_LOCK('" + lock + "', 0)"}, nil); err != nil {
					t.Fatalf("hold the named lock on the pool connection: %v", err)
				}
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
				endKilledSession(t, admin, ids[0], lock)
				killed = 1
			}
			if killed != 1 {
				t.Fatalf("ended %d idle pool sessions, want one", killed)
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
	testcase.Start(t)
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

// endKilledSession kills the idle session id, which holds the named lock lock, and returns when the server answers that its
// thread has ended. One read of IS_USED_LOCK checks that the session holds the lock: a pool that reset the session when it
// took the connection back would have released it. KILL returns before the killed thread has ended; GET_LOCK, whose wait
// of 30 s the server limits, returns 1 once the thread has ended and released the lock (T475).
func endKilledSession(t *testing.T, admin *sql.DB, id int64, lock string) {
	t.Helper()
	conn, err := admin.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, conn)
	var holder sql.NullInt64
	if err := conn.QueryRowContext(t.Context(), `SELECT IS_USED_LOCK(?)`, lock).Scan(&holder); err != nil {
		t.Fatal(err)
	}
	if !holder.Valid || holder.Int64 != id {
		t.Fatalf("the idle session %d does not hold the named lock %s: IS_USED_LOCK is %v, so the pool reset its session when it took it back", id, lock, holder)
	}
	if _, err := conn.ExecContext(t.Context(), "KILL ?", id); err != nil {
		t.Fatalf("end idle MySQL session: %v", err)
	}
	var taken sql.NullInt64
	if err := conn.QueryRowContext(t.Context(), `SELECT GET_LOCK(?, 30)`, lock).Scan(&taken); err != nil {
		t.Fatal(err)
	}
	if !taken.Valid || taken.Int64 != 1 {
		t.Fatalf("GET_LOCK(%s, 30) returned %v: the killed session %d did not end within the limit of the server", lock, taken, id)
	}
	if _, err := conn.ExecContext(t.Context(), `SELECT RELEASE_LOCK(?)`, lock); err != nil {
		t.Fatal(err)
	}
}
