package orm_test

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/pg"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"

	"github.com/polyspec/orm/packages/go/testcase"
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
	return rowEntity("order", s, keywordColumns...)
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
	testcase.Start(t, testcase.Database)
	s := documentSchema(t, keywordSchema)
	eachDatabase(t, []string{"sqlite", "mysql", "postgres"}, s, 1, func(t *testing.T, driver, dsn string, db *orm.DB) {
		ent := keywordEntity(s)
		model := coreFunc(db, ent)
		for i, key := range []string{"a", "b", "a"} {
			c := model()
			c.Set("key", key)
			c.Set("group", i)
			c.Set("select", 1)
			created, err := c.Create()
			if err != nil {
				t.Fatal(err)
			}
			if id, ok := as[*keywordRow](t, created).vals["seq"].(int64); !ok || id <= 0 {
				t.Fatalf("insert did not assign generated ID: %#v", as[*keywordRow](t, created).vals["seq"])
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
		_, err := rejected.Create()
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
