package orm_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

const zoneSchema = `erDiagram
  zone_event {
    bigint       seq     PK "auto"
    datetime(6)  start_dt
    datetime(6)  created_ts "=now"
  }
`

var zoneColumns = []string{"seq", "start_dt", "created_ts"}

func zoneEntity(hash string) *orm.Entity {
	return &orm.Entity{
		Name:   "zone_event",
		Schema: &orm.Schema{Hash: hash},
		New: func(c *orm.Core) orm.Model {
			r := &keywordRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) bool {
			for _, c := range zoneColumns {
				if c == name {
					m.(*keywordRow).vals[name] = v
					return true
				}
			}
			return false
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

// TestConnectionTimeZone writes a wall-clock value and reads it back in the
// connection time zone, and checks that the database clock default is in the
// same zone.
func TestConnectionTimeZone(t *testing.T) {
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
	targets := map[string]string{
		"sqlite":   "sqlite://",
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	for driver, base := range targets {
		if base == "" && driver != "sqlite" {
			t.Run(driver, func(t *testing.T) { requireTarget(t, driver, base) })
			continue
		}
		for _, zone := range []string{"+00:00", "+09:00", "-05:30", "Asia/Seoul"} {
			t.Run(driver+"/"+zone, func(t *testing.T) {
				if driver == "sqlite" {
					base = "sqlite://" + filepath.Join(t.TempDir(), "zone.sqlite")
				}
				sep := "?"
				if strings.Contains(base, "?") {
					sep = "&"
				}
				dsn := base + sep + "timezone=" + strings.ReplaceAll(zone, "+", "%2B")
				dropTable(t, driver, base, "zone_event")
				defer dropTable(t, driver, base, "zone_event")
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
				loc := time.FixedZone("", 0)
				switch zone {
				case "+09:00":
					loc = time.FixedZone(zone, 9*3600)
				case "-05:30":
					loc = time.FixedZone(zone, -(5*3600 + 1800))
				case "Asia/Seoul":
					loc, _ = time.LoadLocation(zone)
				}
				ent := zoneEntity(m.SchemaHash)
				model := func() *orm.Core {
					c := orm.NewCore(ent)
					ent.New(c)
					c.Connect(db)
					return c
				}
				start := time.Date(2026, 1, 2, 0, 0, 0, 0, loc)
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
				if !ok || !got.Equal(start) || got.Format("15:04") != "00:00" {
					t.Fatalf("start_dt = %v, want %v", vals["start_dt"], start)
				}
				created, ok := vals["created_ts"].(time.Time)
				if !ok || created.Sub(before).Abs() > time.Minute {
					t.Fatalf("created_ts = %v, want about %v", vals["created_ts"], before.In(loc))
				}
				filter := model()
				filter.Where("", []orm.ChainKey{{Column: "start_dt"}}, start)
				found, err := filter.GetCount()
				if err != nil || found != 1 {
					t.Fatalf("where start_dt: %d %v", found, err)
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
					{"equal", orm.ChainKey{Column: "start_dt"}, "2026-01-02 00:00:00", 1},
					{"fraction", orm.ChainKey{Column: "start_dt"}, "2026-01-03T00:00:00.0", 1},
					{"in", orm.ChainKey{Column: "start_dt"}, []string{"2026-01-02 00:00:00", "2026-01-03 00:00:00"}, 2},
					{"between", orm.ChainKey{Op: "between", Column: "start_dt"}, [2]string{"2026-01-02 00:00:00", "2026-01-02 23:59:59"}, 1},
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
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "pool.sqlite"),
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
	for driver, dsn := range targets {
		requireTarget(t, driver, dsn)
		t.Run(driver, func(t *testing.T) {
			eng, err := engine.New(m, driver)
			if err != nil {
				t.Fatal(err)
			}
			db, err := orm.Open(dsn, eng, orm.Config{PoolSize: 3})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if got := db.Stats().MaxOpenConnections; got != 3 {
				t.Fatalf("max open connections = %d, want 3", got)
			}
			if _, err := orm.Open(dsn, eng, orm.Config{PoolSize: -1}); err == nil || orm.ErrorCode(err) != orm.CodeConfig {
				t.Fatalf("negative pool size: %v", err)
			}
			unset, err := orm.Open(dsn, eng, orm.Config{})
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
			bounded, err := orm.Open(dsn, eng, orm.Config{PoolSize: 2})
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
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "pool-idle.sqlite"),
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
	for driver, dsn := range targets {
		t.Run(driver, func(t *testing.T) {
			requireTarget(t, driver, dsn)
			eng, err := engine.New(m, driver)
			if err != nil {
				t.Fatal(err)
			}
			for _, cfg := range []orm.Config{{PoolIdleSize: -1}, {PoolSize: 3, PoolIdleSize: 4}, {PoolIdleSize: 11}, {PoolLifetimeMs: -1}} {
				if _, err := orm.Open(dsn, eng, cfg); orm.ErrorCode(err) != orm.CodeConfig {
					t.Fatalf("pool idle size %d, lifetime %d: %v, want CONFIG", cfg.PoolIdleSize, cfg.PoolLifetimeMs, err)
				}
			}
			// Three read-only transactions hold three connections at once,
			// and SQLite begins them without the write lock; after they end
			// the pool keeps one idle connection and closes the others.
			idle, err := orm.Open(dsn, eng, orm.Config{PoolSize: 3, PoolIdleSize: 1})
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
			unset, err := orm.Open(dsn, eng, orm.Config{PoolSize: 3})
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
			aged, err := orm.Open(dsn, eng, orm.Config{PoolLifetimeMs: 100})
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
// session timeout.
func TestStatementTimeout(t *testing.T) {
	// MySQL interrupts a statement that does work; its timeout does not
	// interrupt SLEEP. PostgreSQL interrupts any statement.
	slow := map[string]string{
		"mysql":    "(SELECT COUNT(*) FROM zone_event a, zone_event b WHERE MD5(a.start_dt) < MD5(b.start_dt)) >= 0",
		"postgres": "pg_sleep(2) IS NULL",
	}
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
		requireTarget(t, driver, dsn)
		t.Run(driver, func(t *testing.T) {
			dropTable(t, driver, dsn, "zone_event")
			defer dropTable(t, driver, dsn, "zone_event")
			eng, err := engine.New(m, driver)
			if err != nil {
				t.Fatal(err)
			}
			// The table and its rows are created without a statement timeout;
			// only the checked statement runs on the connection with the timeout.
			setup, err := orm.Open(dsn, eng, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer setup.Close()
			if err := setup.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			ent := zoneEntity(m.SchemaHash)
			{
				rows := 2000
				if driver == "postgres" {
					rows = 1
				}
				for i := 0; i < rows; i++ {
					row := orm.NewCore(ent)
					ent.New(row)
					row.Connect(setup)
					row.Set("start_dt", time.Now())
					if _, err := row.Create(); err != nil {
						t.Fatal(err)
					}
				}
			}
			db, err := orm.Open(dsn, eng, orm.Config{StatementTimeoutMs: 200})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			c := orm.NewCore(ent)
			ent.New(c)
			c.Connect(db)
			c.Raw("", slow[driver], nil)
			if _, err := c.GetCount(); orm.ErrorCode(err) != orm.CodeCanceled {
				t.Fatalf("a statement past the timeout: %v (code %q)", err, orm.ErrorCode(err))
			}
			if _, err := orm.Open(dsn, eng, orm.Config{StatementTimeoutMs: -1}); err == nil || orm.ErrorCode(err) != orm.CodeConfig {
				t.Fatalf("negative statement timeout: %v", err)
			}
		})
	}
}

// TestStatementTimeoutThroughAPooler checks that the statement timeout of one
// connection bounds only the statements of that connection when a pooler in
// transaction mode hands one server session to every client in turn: through
// ORM_TEST_PGBOUNCER_SINGLE_DSN every client shares one server connection.
func TestStatementTimeoutThroughAPooler(t *testing.T) {
	base := requireDSN(t, "ORM_TEST_POSTGRES_DSN")
	single := requireDSN(t, "ORM_TEST_PGBOUNCER_SINGLE_DSN")
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
	eng, err := engine.New(m, "postgres")
	if err != nil {
		t.Fatal(err)
	}
	dropTable(t, "postgres", base, "zone_event")
	defer dropTable(t, "postgres", base, "zone_event")
	setup, err := orm.Open(base, eng, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer setup.Close()
	if err := setup.Utils().Schema().Install(manifest); err != nil {
		t.Fatal(err)
	}
	ent := zoneEntity(m.SchemaHash)
	// Three rows sleep 0.1 s each, so the statement runs past 200 ms.
	for i := 0; i < 3; i++ {
		row := orm.NewCore(ent)
		ent.New(row)
		row.Connect(setup)
		row.Set("start_dt", time.Now())
		if _, err := row.Create(); err != nil {
			t.Fatal(err)
		}
	}
	slowCount := func(db *orm.DB) (int64, error) {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		c.Raw("", "pg_sleep(0.1) IS NOT NULL", nil)
		return c.GetCount()
	}
	bounded, err := orm.Open(single, eng, orm.Config{StatementTimeoutMs: 200})
	if err != nil {
		t.Fatal(err)
	}
	defer bounded.Close()
	if _, err := slowCount(bounded); orm.ErrorCode(err) != orm.CodeCanceled {
		t.Fatalf("the bounded connection through the pooler: %v", err)
	}
	plain, err := orm.Open(single, eng, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer plain.Close()
	if n, err := slowCount(plain); err != nil || n != 3 {
		t.Fatalf("a connection without a timeout after the bounded one: %d, %v", n, err)
	}
	if _, err := slowCount(bounded); orm.ErrorCode(err) != orm.CodeCanceled {
		t.Fatalf("the bounded connection after the plain one: %v", err)
	}
}
