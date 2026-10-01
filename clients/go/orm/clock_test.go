package orm_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

var clockColumns = []string{"seq", "label", "created_ts"}

func clockEntity(hash string) *orm.Entity {
	return &orm.Entity{
		Name:   "clock_event",
		Schema: &orm.Schema{Hash: hash},
		New: func(c *orm.Core) orm.Model {
			r := &keywordRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) (bool, error) {
			for _, c := range clockColumns {
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

// clockMicroseconds inserts sixteen clock_event rows in separate statements
// and reads created_ts, which the clock fills. Each value lies near the wall
// clock with microsecond resolution, and at least one has microseconds that
// a millisecond clock cannot give.
func clockMicroseconds(t *testing.T, driver string) {
	manifest, err := os.ReadFile("../../../contracts/fixtures/clock_schema.json")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Load(manifest)
	if err != nil {
		t.Fatal(err)
	}
	base := "sqlite://" + filepath.Join(t.TempDir(), "clock.sqlite")
	if driver != "sqlite" {
		base = requireDSN(t, "ORM_TEST_"+strings.ToUpper(driver)+"_DSN")
	}
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	dropTable(t, driver, base, "clock_event")
	defer dropTable(t, driver, base, "clock_event")
	eng, err := engine.New(m, driver)
	if err != nil {
		t.Fatal(err)
	}
	db, err := orm.Open(base+sep+"timezone=%2B00:00", eng, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Utils().Schema().Install(manifest); err != nil {
		t.Fatal(err)
	}
	ent := clockEntity(m.SchemaHash)
	model := func() *orm.Core {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		return c
	}
	before := time.Now()
	var seqs []any
	for i := range 16 {
		c := model()
		c.Set("label", "event-"+string(rune('a'+i)))
		created, err := c.Create()
		if err != nil {
			t.Fatal(err)
		}
		seqs = append(seqs, created.(*keywordRow).vals["seq"])
	}
	after := time.Now()
	sub := false
	for _, seq := range seqs {
		q := model()
		q.AddAllColumns()
		q.Where("", []orm.ChainKey{{Column: "seq"}}, seq)
		row, err := q.Get()
		if err != nil {
			t.Fatal(err)
		}
		created, ok := row.(*keywordRow).vals["created_ts"].(time.Time)
		if !ok {
			t.Fatalf("created_ts = %#v", row.(*keywordRow).vals["created_ts"])
		}
		if created.Nanosecond()%1000 != 0 {
			t.Fatalf("created_ts %v has more than six fraction digits", created)
		}
		if created.Before(before.Truncate(time.Microsecond)) || created.After(after) {
			t.Fatalf("created_ts %v lies outside %v and %v", created, before, after)
		}
		if created.Nanosecond()%int(time.Millisecond) != 0 {
			sub = true
		}
	}
	if !sub {
		t.Fatal("every created_ts ends in 000")
	}
}

func TestClockMicrosecondsSQLite(t *testing.T)   { clockMicroseconds(t, "sqlite") }
func TestClockMicrosecondsMySQL(t *testing.T)    { clockMicroseconds(t, "mysql") }
func TestClockMicrosecondsPostgres(t *testing.T) { clockMicroseconds(t, "postgres") }
