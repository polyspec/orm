package orm_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

// TestPoolSize applies the configured maximum of open connections.
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
			db, err := orm.Open(dsn, eng, orm.Config{StatementTimeoutMs: 200})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(manifest); err != nil {
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
					row.Connect(db)
					row.Set("start_dt", time.Now())
					if _, err := row.Create(); err != nil {
						t.Fatal(err)
					}
				}
			}
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
