package orm_test

import (
	"database/sql"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/clients/go/orm"
	_ "github.com/polyspec/orm/clients/go/orm/pg"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

// keywordRow is a hand-written model for a table and columns named with SQL
// keywords.
type keywordRow struct {
	m    *orm.Core
	vals map[string]any
}

func (r *keywordRow) Orm_() *orm.Core { return r.m }

var keywordColumns = []string{"seq", "key", "group", "select"}

func keywordEntity(hash string) *orm.Entity {
	return &orm.Entity{
		Name:   "order",
		Schema: &orm.Schema{Hash: hash},
		New: func(c *orm.Core) orm.Model {
			r := &keywordRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) bool {
			for _, c := range keywordColumns {
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

const keywordSchema = `erDiagram
  order {
    bigint       seq     PK "auto"
    varchar(20)  key
    int          group      "=0"
    int          select     "=0"
  }
  %% index order (key, group) ix_key
`

// TestSQLKeywordNames creates, reads, groups, updates, and deletes rows of a
// table whose table and column names are SQL keywords.
func TestSQLKeywordNames(t *testing.T) {
	d, err := schema.Parse(keywordSchema)
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
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "keyword.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	for driver, dsn := range targets {
		if dsn == "" {
			continue
		}
		t.Run(driver, func(t *testing.T) {
			dropTable(t, driver, dsn, "order")
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
			defer dropTable(t, driver, dsn, "order")
			ent := keywordEntity(m.SchemaHash)
			model := func() *orm.Core {
				c := orm.NewCore(ent)
				ent.New(c)
				c.Connect(db)
				return c
			}
			for i, key := range []string{"a", "b", "a"} {
				c := model()
				c.Set("key", key)
				c.Set("group", i)
				c.Set("select", 1)
				if _, err := c.Create(); err != nil {
					t.Fatal(err)
				}
			}
			q := model()
			q.Where("", []orm.ChainKey{{Column: "key"}}, "a")
			q.OrderBy("group", true, nil)
			rows, err := orm.Gets[*keywordRow](q)
			if err != nil {
				t.Fatal(err)
			}
			if rows.Len() != 2 || orm.AsInt64(rows.First().vals["group"]) != 2 {
				t.Fatalf("rows: %d %v", rows.Len(), rows.First().vals)
			}
			grouped := model()
			grouped.GroupBy("key")
			groups, err := orm.GetsCount[*keywordRow](grouped)
			if err != nil {
				t.Fatal(err)
			}
			if groups.Len() != 2 {
				t.Fatalf("groups: %d", groups.Len())
			}
			first := rows.First().Orm_()
			first.Set("select", 5)
			if err := first.Update(nil); err != nil {
				t.Fatal(err)
			}
			sum := model()
			sum.Aggregate("sum", "select")
			total, err := sum.GetSum()
			if err != nil || total != 7 {
				t.Fatalf("sum: %v %v", total, err)
			}
			if err := rows.Delete(); err != nil {
				t.Fatal(err)
			}
			left, err := model().GetCount()
			if err != nil || left != 1 {
				t.Fatalf("left: %d %v", left, err)
			}
		})
	}
}

func dropTable(t *testing.T, driver, dsn, table string) {
	t.Helper()
	sqlDriver, native := driver, dsn
	switch driver {
	case "sqlite":
		return
	case "postgres":
		sqlDriver = "pgx"
	case "mysql":
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		cfg := mysql.NewConfig()
		cfg.User = u.User.Username()
		cfg.DBName = strings.TrimPrefix(u.Path, "/")
		cfg.Net, cfg.Addr = "tcp", u.Host
		if socket := u.Query().Get("socket"); socket != "" {
			cfg.Net, cfg.Addr = "unix", socket
		}
		native = cfg.FormatDSN()
	}
	raw, err := sql.Open(sqlDriver, native)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	stmt := `DROP TABLE IF EXISTS "` + table + `"`
	if driver == "mysql" {
		stmt = "DROP TABLE IF EXISTS `" + table + "`"
	}
	if _, err := raw.Exec(stmt); err != nil {
		t.Fatal(err)
	}
}
