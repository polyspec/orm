package orm_test

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/internal/testdb"
)

var zoneColumns = []string{"seq", "start_dt", "created_ts"}

func zoneEntity(s *orm.Schema) *orm.Entity {
	return &orm.Entity{
		Name:   "zone_event",
		Schema: s,
		New: func(c *orm.Core) orm.Model {
			r := &keywordRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) (bool, error) {
			for _, c := range zoneColumns {
				if c == name {
					m.(*keywordRow).vals[name] = v
					return true, nil
				}
			}
			return false, nil
		},
		Value: func(m orm.Model, name string) (any, bool) {
			v, ok := m.(*keywordRow).vals[name]
			return v, ok
		},
		Collect: func(keys []orm.Key, items map[orm.Key]*orm.Core, fetched map[orm.Key]any) any {
			return orm.CollectOf[*keywordRow](keys, items, fetched)
		},
	}
}

// TestConnectionsUseUTC는 모든 connection이 server의 time zone과 상관없이
// datetime을 UTC로 읽고 쓰는지 확인한다(docs/dialects.md "Date and time"). 시험
// server의 MySQL은 SYSTEM(KST), PostgreSQL은 Asia/Seoul이다. offset이 있는 값은
// UTC wall clock으로 저장되고 UTC location으로 읽히며, clock default도 UTC다.
func TestConnectionsUseUTC(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "zone")
	manifest := s
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		for _, zone := range []string{"", "UTC", "+00:00"} {
			t.Run(driver+"/"+zone, func(t *testing.T) {
				base := newDatabase(t, driver)
				dsn := base
				if zone != "" {
					sep := "?"
					if strings.Contains(base, "?") {
						sep = "&"
					}
					dsn = base + sep + "timezone=" + strings.ReplaceAll(zone, "+", "%2B")
				}
				db, err := orm.ConnectSchema(dsn, s, orm.Config{})
				if err != nil {
					t.Fatal(err)
				}
				defer db.Close()
				if err := db.Utils().Schema().Install(manifest); err != nil {
					t.Fatal(err)
				}
				ent := zoneEntity(s)
				model := func() *orm.Core {
					c := orm.NewCore(ent)
					ent.New(c)
					c.Connect(db)
					return c
				}
				start := time.Date(2026, 1, 2, 0, 0, 0, 0, time.FixedZone("+09:00", 9*3600))
				c := model()
				c.Set("start_dt", start)
				before := time.Now()
				if _, err := c.Create(); err != nil {
					t.Fatal(err)
				}
				row, err := model().Get()
				if err != nil || row == nil {
					t.Fatalf("get: %v %v", row, err)
				}
				vals := row.(*keywordRow).vals
				got, ok := vals["start_dt"].(time.Time)
				if !ok || !got.Equal(start) || got.Location() != time.UTC || got.Format("2006-01-02 15:04") != "2026-01-01 15:00" {
					t.Fatalf("start_dt = %v, want %v in UTC", vals["start_dt"], start.UTC())
				}
				created, ok := vals["created_ts"].(time.Time)
				if !ok || created.Location() != time.UTC || created.Sub(before).Abs() > time.Minute {
					t.Fatalf("created_ts = %v, want about %v in UTC", vals["created_ts"], before.UTC())
				}
				text := model()
				text.Set("start_dt", "2026-01-03 00:00:00")
				if _, err := text.Create(); err != nil {
					t.Fatal(err)
				}
				for _, filter := range []struct {
					name string
					key  orm.ChainKey
					arg  any
					want int64
				}{
					{"instant", orm.ChainKey{Column: "start_dt"}, start, 1},
					{"equal", orm.ChainKey{Column: "start_dt"}, "2026-01-01 15:00:00", 1},
					{"fraction", orm.ChainKey{Column: "start_dt"}, "2026-01-03T00:00:00.0", 1},
					{"in", orm.ChainKey{Column: "start_dt"}, []string{"2026-01-01 15:00:00", "2026-01-03 00:00:00"}, 2},
					{"between", orm.ChainKey{Op: "between", Column: "start_dt"}, [2]string{"2026-01-01 15:00:00", "2026-01-02 23:59:59"}, 1},
				} {
					q := model()
					q.Where("", []orm.ChainKey{filter.key}, filter.arg)
					got, err := q.GetCount()
					if err != nil || got != filter.want {
						t.Fatalf("%s: %d %v, want %d", filter.name, got, err, filter.want)
					}
				}
				if driver == "sqlite" {
					bad := model()
					bad.Where("", []orm.ChainKey{{Column: "start_dt"}}, "2026-01-02")
					if _, err := bad.GetCount(); orm.ErrorCode(err) != orm.CodeCodecEncode {
						t.Fatalf("date-only datetime text: %v, want CODEC_ENCODE", err)
					}
				}
			})
		}
	}
}

// TestPoolSize applies the configured maximum of open connections, 10 when
// PoolSize is zero, and never runs more concurrent transactions or opens more
// connections than the maximum.
func TestPoolSize(t *testing.T) {
	testcase.Start(t, testcase.Database)
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "pool.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	s := fixtureSchema(t, "zone")
	for driver, dsn := range targets {
		requireTarget(t, driver, dsn)
		t.Run(driver, func(t *testing.T) {
			db, err := orm.ConnectSchema(dsn, s, orm.Config{PoolSize: 3})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if got := db.Stats().MaxOpenConnections; got != 3 {
				t.Fatalf("max open connections = %d, want 3", got)
			}
			if _, err := orm.ConnectSchema(dsn, s, orm.Config{PoolSize: -1}); err == nil || orm.ErrorCode(err) != orm.CodeConfig {
				t.Fatalf("negative pool size: %v", err)
			}
			unset, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer unset.Close()
			if got := unset.Stats().MaxOpenConnections; got != 10 {
				t.Fatalf("max open connections without a pool size = %d, want 10", got)
			}
			if driver == "sqlite" {
				return
			}
			// Each transaction holds a connection while it runs, so six
			// transactions on a pool of two run at most two at a time.
			bounded, err := orm.ConnectSchema(dsn, s, orm.Config{PoolSize: 2})
			if err != nil {
				t.Fatal(err)
			}
			defer bounded.Close()
			var active, peak, opened atomic.Int32
			var wg sync.WaitGroup
			for i := 0; i < 6; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					err := bounded.Transaction(func() error {
						n := active.Add(1)
						defer active.Add(-1)
						for p := peak.Load(); n > p && !peak.CompareAndSwap(p, n); p = peak.Load() {
						}
						if open := int32(bounded.Stats().OpenConnections); open > opened.Load() {
							opened.Store(open)
						}
						time.Sleep(50 * time.Millisecond)
						return nil
					})
					if err != nil {
						t.Error(err)
					}
				}()
			}
			wg.Wait()
			if peak.Load() != 2 || opened.Load() > 2 {
				t.Fatalf("pool of 2: %d concurrent transactions, %d open connections", peak.Load(), opened.Load())
			}
		})
	}
}

// TestPoolIdleSizeAndLifetime keeps at most PoolIdleSize idle connections,
// closes a connection PoolLifetimeMs after it was opened, and rejects a
// negative value or an idle size above the pool size with CONFIG.
func TestPoolIdleSizeAndLifetime(t *testing.T) {
	testcase.Start(t, testcase.Database)
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "pool-idle.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	s := fixtureSchema(t, "zone")
	for driver, dsn := range targets {
		t.Run(driver, func(t *testing.T) {
			requireTarget(t, driver, dsn)
			for _, cfg := range []orm.Config{{PoolIdleSize: -1}, {PoolSize: 3, PoolIdleSize: 4}, {PoolIdleSize: 11}, {PoolLifetimeMs: -1}} {
				if _, err := orm.ConnectSchema(dsn, s, cfg); orm.ErrorCode(err) != orm.CodeConfig {
					t.Fatalf("pool idle size %d, lifetime %d: %v, want CONFIG", cfg.PoolIdleSize, cfg.PoolLifetimeMs, err)
				}
			}
			// Three read-only transactions hold three connections at once,
			// and SQLite begins them without the write lock; after they end
			// the pool keeps one idle connection and closes the others.
			idle, err := orm.ConnectSchema(dsn, s, orm.Config{PoolSize: 3, PoolIdleSize: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer idle.Close()
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
			defer unset.Close()
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
			// The pool closes an idle connection whose lifetime has passed
			// on its next cleanup, which runs at least once a second.
			aged, err := orm.ConnectSchema(dsn, s, orm.Config{PoolLifetimeMs: 100})
			if err != nil {
				t.Fatal(err)
			}
			defer aged.Close()
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

// TestStatementTimeout bounds every statement of the connection. MySQL bounds
// SELECT statements, PostgreSQL bounds every statement, and SQLite has no
// session timeout. The bounded statement is a locking read of a row that
// another connection holds in an open transaction, so it waits for the lock
// past the bound.
func TestStatementTimeout(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "zone")
	manifest := s
	for _, driver := range []string{"mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			dsn := newDatabase(t, driver)
			// The table and its rows are created without a statement timeout;
			// only the checked statement runs on the connection with the timeout.
			setup, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer setup.Close()
			if err := setup.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			ent := zoneEntity(s)
			row := orm.NewCore(ent)
			ent.New(row)
			row.Connect(setup)
			row.Set("start_dt", time.Now())
			if _, err := row.Create(); err != nil {
				t.Fatal(err)
			}
			holdRows(t, driver, dsn, "zone_event")
			db, err := orm.ConnectSchema(dsn, s, orm.Config{StatementTimeoutMs: 200})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := lockedRead(db, ent); orm.ErrorCode(err) != orm.CodeCanceled {
				t.Fatalf("a statement past the timeout: %v (code %q)", err, orm.ErrorCode(err))
			}
			if _, err := orm.ConnectSchema(dsn, s, orm.Config{StatementTimeoutMs: -1}); err == nil || orm.ErrorCode(err) != orm.CodeConfig {
				t.Fatalf("negative statement timeout: %v", err)
			}
		})
	}
}

// lockedRead는 db의 transaction에서 ent의 행을 FOR UPDATE로 읽는다. 다른 연결이 그 행을 잡고
// 있으면 lock을 기다린다.
func lockedRead(db *orm.DB, ent *orm.Entity) error {
	return db.Transaction(func() error {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		c.Lock("update")
		_, err := c.Get()
		return err
	}, orm.Retry(0))
}

// TestStatementTimeoutThroughAPooler checks that the statement timeout of one
// connection bounds only the statements of that connection when a pooler in
// transaction mode hands one server session to every client in turn: through
// ORM_TEST_PGBOUNCER_SINGLE_DSN every client shares one server connection.
// PgBouncer의 orm_test_single은 ORM_TEST_POSTGRES_DSN의 database에 묶여 있어 case
// database에 닿지 못하므로, case는 그 database에 자기 이름(testdb.Name)의 table 하나를
// 만들고 끝날 때 실패한 뒤에도 그 table만 지운다.
func TestStatementTimeoutThroughAPooler(t *testing.T) {
	c := testcase.Start(t, testcase.Database)
	base := requireDSN(t, "ORM_TEST_POSTGRES_DSN")
	single := requireDSN(t, "ORM_TEST_PGBOUNCER_SINGLE_DSN")
	table := testdb.Name()
	s := documentSchema(t, "dbspec 1 zone\n\ntable "+table+" {\n  seq i64 identity\n  start_dt datetime(6)\n  created_ts datetime(6) default now\n  primary key (seq)\n}\n")
	manifest := s
	t.Cleanup(func() {
		raw := openNative(t, "postgres", base)
		defer raw.Close()
		if _, err := raw.Exec(`DROP TABLE IF EXISTS "` + table + `"`); err != nil {
			t.Errorf("drop case table %s: %v", table, err)
			return
		}
		c.Step("table %s dropped", table)
	})
	setup, err := orm.ConnectSchema(base, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer setup.Close()
	if err := setup.Utils().Schema().Install(manifest); err != nil {
		t.Fatal(err)
	}
	c.Step("table %s created", table)
	ent := rowEntity(table, s, zoneColumns...)
	for i := 0; i < 3; i++ {
		row := orm.NewCore(ent)
		ent.New(row)
		row.Connect(setup)
		row.Set("start_dt", time.Now())
		if _, err := row.Create(); err != nil {
			t.Fatal(err)
		}
	}
	// A direct connection holds the rows, so a locking read through the pooler
	// waits for the lock.
	release := holdRows(t, "postgres", base, table)
	bounded, err := orm.ConnectSchema(single, s, orm.Config{StatementTimeoutMs: 200})
	if err != nil {
		t.Fatal(err)
	}
	defer bounded.Close()
	if err := lockedRead(bounded, ent); orm.ErrorCode(err) != orm.CodeCanceled {
		t.Fatalf("the bounded connection through the pooler: %v", err)
	}
	plain, err := orm.ConnectSchema(single, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer plain.Close()
	// The holder keeps the rows for a declared 400 ms, past the 200 ms bound of
	// the other connection, so the plain read waits that long and then succeeds.
	held := time.AfterFunc(400*time.Millisecond, release)
	defer held.Stop()
	started := time.Now()
	if err := lockedRead(plain, ent); err != nil {
		t.Fatalf("a connection without a timeout after the bounded one: %v", err)
	}
	if waited := time.Since(started); waited < 200*time.Millisecond {
		t.Fatalf("the plain read waited %s, not past the bound of the other connection", waited)
	}
	holdRows(t, "postgres", base, table)
	if err := lockedRead(bounded, ent); orm.ErrorCode(err) != orm.CodeCanceled {
		t.Fatalf("the bounded connection after the plain one: %v", err)
	}
}
