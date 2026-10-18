package orm_test

import (
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

var clockColumns = []string{"seq", "label", "created_ts"}

var clockMarkColumns = []string{"seq", "label", "created_ts", "deleted_at"}

// openClock installs the contracts/fixtures document in a new SQLite file or a new
// test database of the driver, and returns the DSN and the connection.
func openClock(t *testing.T, driver, document string) (*orm.Schema, string, *orm.DB) {
	t.Helper()
	s := fixtureSchema(t, document)
	dsn := newDatabase(t, driver)
	db, err := orm.ConnectSchema(dsn, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Utils().Schema().Install(s); err != nil {
		t.Fatal(err)
	}
	return s, dsn, db
}

// clockMicroseconds inserts sixteen clock_event rows one at a time and reads the
// created_ts the clock filled in. Every value has microsecond resolution near the wall clock, and at least
// one has a microsecond that a millisecond clock cannot give.
func clockMicroseconds(t *testing.T, driver string) {
	s, _, db := openClock(t, driver, "clock")
	ent := rowEntity("clock_event", s, clockColumns...)
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

func TestClockMicrosecondsSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	clockMicroseconds(t, "sqlite")
}
func TestClockMicrosecondsMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	clockMicroseconds(t, "mysql")
}
func TestClockMicrosecondsPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	clockMicroseconds(t, "postgres")
}

// openClockMark installs the clock_mark document and returns the DSN and the model constructor.
func openClockMark(t *testing.T, driver string) (string, *orm.DB, func() *orm.Core) {
	s, dsn, db := openClock(t, driver, "clock_mark")
	ent := rowEntity("clock_mark", s, clockMarkColumns...)
	return dsn, db, func() *orm.Core {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		return c
	}
}

// clockSoftDeleteMicroseconds soft-deletes sixteen clock_mark rows one at a time,
// and since a model read omits soft-deleted rows, it reads deleted_at with the native driver.
// Every value has six fractional digits, and at least one has a
// microsecond that a second-resolution clock cannot give.
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
	// The modernc driver reads a column declared DATETIME as time.Time, so it reads the stored
	// text with CAST.
	query := "SELECT CAST(deleted_at AS TEXT) FROM clock_mark ORDER BY seq"
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

// clockNowCondition creates sixteen clock_mark rows and, right after each insert,
// reads them again with created_ts <= now() and created_ts <= secondsLater(0). The condition's
// database clock is later than the stored creation time, so both conditions match the row.
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

func TestClockSoftDeleteMicrosecondsSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	clockSoftDeleteMicroseconds(t, "sqlite")
}
func TestClockSoftDeleteMicrosecondsMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	clockSoftDeleteMicroseconds(t, "mysql")
}
func TestClockSoftDeleteMicrosecondsPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	clockSoftDeleteMicroseconds(t, "postgres")
}
func TestClockNowConditionSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	clockNowCondition(t, "sqlite")
}
func TestClockNowConditionMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	clockNowCondition(t, "mysql")
}
func TestClockNowConditionPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	clockNowCondition(t, "postgres")
}
