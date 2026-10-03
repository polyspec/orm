package orm_test

import (
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
)

var clockColumns = []string{"seq", "label", "created_ts"}

var clockMarkColumns = []string{"seq", "label", "created_ts", "deleted_at"}

// openClock은 contracts/fixtures의 document를 새 SQLite file이나 driver의 새
// test database에 설치하고 DSN과 connection을 돌려준다.
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

// clockMicroseconds는 clock_event row 열여섯 개를 따로 insert하고 clock이 채운
// created_ts를 읽는다. 모든 값은 wall clock 근처의 microsecond 해상도이고, 적어도
// 하나는 millisecond clock이 줄 수 없는 microsecond를 가진다.
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

func TestClockMicrosecondsSQLite(t *testing.T)   { clockMicroseconds(t, "sqlite") }
func TestClockMicrosecondsMySQL(t *testing.T)    { clockMicroseconds(t, "mysql") }
func TestClockMicrosecondsPostgres(t *testing.T) { clockMicroseconds(t, "postgres") }

// openClockMark은 clock_mark document를 설치하고 DSN과 model 생성 함수를 돌려준다.
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

// clockSoftDeleteMicroseconds는 clock_mark row 열여섯 개를 따로 soft delete하고,
// model read는 soft delete된 row를 빼므로 deleted_at을 native driver로 읽는다.
// 모든 값은 소수 여섯 자리이고, 적어도 하나는 초 단위 clock이 줄 수 없는
// microsecond를 가진다.
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
	// modernc driver는 DATETIME으로 선언된 column을 time.Time으로 읽으므로 저장된
	// text를 CAST로 읽는다.
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

// clockNowCondition은 clock_mark row 열여섯 개를 만들고 각 insert 직후
// created_ts <= now()와 created_ts <= secondsLater(0)으로 다시 읽는다. 조건의
// database clock은 저장된 생성 시각보다 늦으므로 두 조건 모두 row에 맞는다.
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
