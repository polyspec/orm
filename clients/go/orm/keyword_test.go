package orm_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	_ "github.com/polyspec/orm/clients/go/orm/pg"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"
)

// keywordRow is a hand-written model for a table and columns named with SQL
// keywords.
type keywordRow struct {
	m    *orm.Core
	vals map[string]any
}

func (r *keywordRow) Orm_() *orm.Core { return r.m }

var keywordColumns = []string{"seq", "key", "group", "select"}

func keywordEntity(s *orm.Schema) *orm.Entity {
	return &orm.Entity{
		Name:   "order",
		Schema: s,
		New: func(c *orm.Core) orm.Model {
			r := &keywordRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) (bool, error) {
			for _, c := range keywordColumns {
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

const keywordSchema = `dbspec 1 keyword

table order {
  seq i64 identity
  key varchar(20)
  group i32 default 0
  select i32 default 0
  primary key (seq)
  index ix_key (key, group)
}
`

// TestSQLKeywordNames creates, reads, groups, updates, and deletes rows of a
// table whose table and column names are SQL keywords.
func TestSQLKeywordNames(t *testing.T) {
	s := documentSchema(t, keywordSchema)
	manifest := s
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "keyword.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	for driver, dsn := range targets {
		t.Run(driver, func(t *testing.T) {
			requireTarget(t, driver, dsn)
			dropTable(t, driver, dsn, "order")
			db, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			defer dropTable(t, driver, dsn, "order")
			ent := keywordEntity(s)
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
				created, err := c.Create()
				if err != nil {
					t.Fatal(err)
				}
				if id, ok := created.(*keywordRow).vals["seq"].(int64); !ok || id <= 0 {
					t.Fatalf("insert did not assign generated ID: %#v", created.(*keywordRow).vals["seq"])
				} else {
					read := model()
					read.Where("", []orm.ChainKey{{Column: "seq"}}, id)
					stored, err := orm.Gets[*keywordRow](read)
					if err != nil || stored.Len() != 1 || stored.First().vals["seq"] != id {
						t.Fatalf("generated ID differs from stored row: %d, %v", id, err)
					}
				}
			}
			assignmentError := errors.New("invalid key value")
			baseAssign := ent.Assign
			ent.Assign = func(m orm.Model, name string, value any) (bool, error) {
				if name == "key" && value == "reject" {
					return true, assignmentError
				}
				return baseAssign(m, name, value)
			}
			rejected := model()
			rejected.Set("key", "reject")
			rejected.Set("group", 0)
			rejected.Set("select", 1)
			_, err = rejected.Create()
			ent.Assign = baseAssign
			if !errors.Is(err, assignmentError) {
				t.Fatalf("assignment failure: %v", err)
			}
			if count, err := model().GetCount(); err != nil || count != 3 {
				t.Fatalf("rejected assignment wrote a row: count %d, error %v", count, err)
			}
			q := model()
			q.Where("", []orm.ChainKey{{Column: "key"}}, "a")
			q.OrderBy("group", true, nil)
			rows, err := orm.Gets[*keywordRow](q)
			if err != nil {
				t.Fatal(err)
			}
			if rows.Len() != 2 || mustInt64(rows.First().vals["group"]) != 2 {
				t.Fatalf("rows: %d %v", rows.Len(), rows.First().vals)
			}
			grouped := model()
			grouped.GroupBy("key")
			groups, err := orm.GetsCount(grouped)
			if err != nil {
				t.Fatal(err)
			}
			if groups.Len() != 2 {
				t.Fatalf("groups: %d", groups.Len())
			}
			counts := map[string]int64{}
			for row := range groups.All() {
				key, err := row.Value("key")
				if err != nil {
					t.Fatal(err)
				}
				name, ok := key.(string)
				if !ok {
					t.Fatalf("grouped key has type %T", key)
				}
				if _, err := row.Value("seq"); orm.ErrorCode(err) != orm.CodeColumnUnselected {
					t.Fatalf("unselected grouped model key error = %v", err)
				}
				counts[name] = row.Count()
			}
			if counts["a"] != 2 || counts["b"] != 1 {
				t.Fatalf("grouped keyword counts: %#v", counts)
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
