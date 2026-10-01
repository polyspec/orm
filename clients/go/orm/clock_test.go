package orm_test

import (
	"database/sql"
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

func clockEntity(hash string) *orm.Entity { return clockEntityOf("clock_event", hash, clockColumns) }

func clockEntityOf(name, hash string, columns []string) *orm.Entity {
	return &orm.Entity{
		Name:   name,
		Schema: &orm.Schema{Hash: hash},
		New: func(c *orm.Core) orm.Model {
			r := &keywordRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) (bool, error) {
			for _, c := range columns {
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

var clockMarkColumns = []string{"seq", "label", "created_ts", "deleted_at"}

// openClockMark installs the clock_mark schema on a new SQLite file or on the
// test database of the driver and returns the connection and a model factory.
func openClockMark(t *testing.T, driver string) (string, *orm.DB, func() *orm.Core) {
	manifest, err := os.ReadFile("../../../contracts/fixtures/clock_mark_schema.json")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Load(manifest)
	if err != nil {
		t.Fatal(err)
	}
	base := "sqlite://" + filepath.Join(t.TempDir(), "clock_mark.sqlite")
	if driver != "sqlite" {
		base = requireDSN(t, "ORM_TEST_"+strings.ToUpper(driver)+"_DSN")
	}
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	dropTable(t, driver, base, "clock_mark")
	t.Cleanup(func() { dropTable(t, driver, base, "clock_mark") })
	eng, err := engine.New(m, driver)
	if err != nil {
		t.Fatal(err)
	}
	db, err := orm.Open(base+sep+"timezone=%2B00:00", eng, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Utils().Schema().Install(manifest); err != nil {
		t.Fatal(err)
	}
	ent := clockEntityOf("clock_mark", m.SchemaHash, clockMarkColumns)
	return base, db, func() *orm.Core {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		return c
	}
}

// clockSoftDeleteMicroseconds soft-deletes sixteen clock_mark rows in
// separate statements and reads deleted_at with the native driver, because
// model reads exclude soft-deleted rows. Every value has six fraction digits
// and at least one has microseconds that a whole-second clock cannot give.
func clockSoftDeleteMicroseconds(t *testing.T, driver string) {
	base, _, model := openClockMark(t, driver)
	for i := range 16 {
		c := model()
		c.Set("label", "mark-"+string(rune('a'+i)))
		created, err := c.Create()
		if err != nil {
			t.Fatal(err)
		}
		if err := created.(*keywordRow).m.Delete(nil); err != nil {
			t.Fatal(err)
		}
	}
	var raw *sql.DB
	query := "SELECT deleted_at FROM clock_mark ORDER BY seq"
	switch driver {
	case "sqlite":
		var err error
		raw, err = sql.Open("sqlite", strings.TrimPrefix(base, "sqlite://"))
		if err != nil {
			t.Fatal(err)
		}
	case "mysql":
		raw = openNative(t, driver, base)
		query = "SELECT DATE_FORMAT(deleted_at, '%Y-%m-%d %H:%i:%s.%f') FROM clock_mark ORDER BY seq"
	default:
		raw = openNative(t, driver, base)
		query = "SELECT to_char(deleted_at, 'YYYY-MM-DD HH24:MI:SS.US') FROM clock_mark ORDER BY seq"
	}
	defer raw.Close()
	rows, err := raw.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var stamps []string
	for rows.Next() {
		var stamp sql.NullString
		if err := rows.Scan(&stamp); err != nil {
			t.Fatal(err)
		}
		if !stamp.Valid {
			t.Fatal("deleted_at is NULL after a soft deletion")
		}
		stamps = append(stamps, stamp.String)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(stamps) != 16 {
		t.Fatalf("rows %d", len(stamps))
	}
	sub := false
	for _, stamp := range stamps {
		if _, err := time.Parse("2006-01-02 15:04:05.000000", stamp); err != nil {
			t.Fatalf("deleted_at %q has six fraction digits: %v", stamp, err)
		}
		if !strings.HasSuffix(stamp, "000") {
			sub = true
		}
	}
	if !sub {
		t.Fatalf("every deleted_at ends in 000: %v", stamps)
	}
}

// clockNowCondition creates sixteen clock_mark rows and reads each one back
// right after its insert with created_ts <= now() and created_ts <=
// secondsLater(0). The database clock of the condition is later than the
// stored creation time, so both conditions match the row.
func clockNowCondition(t *testing.T, driver string) {
	_, _, model := openClockMark(t, driver)
	for i := range 16 {
		c := model()
		c.Set("label", "mark-"+string(rune('a'+i)))
		created, err := c.Create()
		if err != nil {
			t.Fatal(err)
		}
		seq := created.(*keywordRow).vals["seq"]
		for _, fn := range []orm.Func{orm.Now(), orm.SecondsLater(0)} {
			q := model()
			q.AddAllColumns()
			q.Where("", []orm.ChainKey{{Column: "seq"}, {Conn: "and", Op: "le", Column: "created_ts"}}, seq, fn)
			row, err := q.Get()
			if err != nil {
				t.Fatalf("row %v with created_ts <= %v: %v", seq, fn, err)
			}
			if row.(*keywordRow).vals["seq"] != seq {
				t.Fatalf("row %v read %v", seq, row.(*keywordRow).vals["seq"])
			}
		}
	}
}

func TestClockSoftDeleteMicrosecondsSQLite(t *testing.T) { clockSoftDeleteMicroseconds(t, "sqlite") }
func TestClockSoftDeleteMicrosecondsMySQL(t *testing.T)  { clockSoftDeleteMicroseconds(t, "mysql") }
func TestClockSoftDeleteMicrosecondsPostgres(t *testing.T) {
	clockSoftDeleteMicroseconds(t, "postgres")
}
func TestClockNowConditionSQLite(t *testing.T)   { clockNowCondition(t, "sqlite") }
func TestClockNowConditionMySQL(t *testing.T)    { clockNowCondition(t, "mysql") }
func TestClockNowConditionPostgres(t *testing.T) { clockNowCondition(t, "postgres") }
