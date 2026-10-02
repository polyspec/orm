package orm_test

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
)

// historyRow는 audit history table의 한 행이다.
type historyRow struct {
	change    string
	previous  sql.NullInt64
	seq       int64
	title     string
	operation int64
	deleted   bool
}

// TestAuditOperationID는 contracts/fixtures/audit.dbs를 세 database에
// 설치하고, transaction의 operation id가 audit table의 insert, update, soft
// delete에서 operation column에 쓰이며 database trigger가 그 version을
// history table에 남기는지 확인한다. operation id가 없거나 column type에
// 맞지 않는 write는 CONFIG다.
func TestAuditOperationID(t *testing.T) {
	s := fixtureSchema(t, "audit")
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			start := time.Now()
			t.Logf("start %s", driver)
			defer func() { t.Logf("end %s in %s", driver, time.Since(start)) }()
			// 새 database라 이전 실행의 table, trigger, function이 남지 않는다.
			dsn := newDatabase(t, driver)
			sqlitePath := strings.TrimPrefix(dsn, "sqlite://")
			db, err := orm.Connect(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(s.Text); err != nil {
				t.Fatal(err)
			}
			items := rowEntity("item", s, "seq", "title", "operation_id", "deleted_at")
			create := func(title string) (int64, error) {
				c := orm.NewCore(items)
				c.Connect(db)
				c.Set("title", title)
				row, err := c.Create()
				if err != nil {
					return 0, err
				}
				return row.(*keywordRow).vals["seq"].(int64), nil
			}
			byKey := func(seq int64) *orm.Core {
				c := orm.NewCore(items)
				c.Connect(db)
				c.Set("seq", seq)
				return c
			}

			if _, err := create("outside"); orm.ErrorCode(err) != orm.CodeConfig {
				t.Fatalf("insert without an operation id = %v, want CONFIG", err)
			}
			if err := db.Transaction(func() error { _, err := create("wrong type"); return err }, orm.Operation("not-a-number"), orm.Retry(0)); orm.ErrorCode(err) != orm.CodeConfig {
				t.Fatalf("string operation id on an i64 column = %v, want CONFIG", err)
			}
			if err := db.Transaction(func() error { return nil }, orm.Operation(7)); orm.ErrorCode(err) != orm.CodeConfig {
				t.Fatalf("int operation id = %v, want CONFIG", err)
			}

			var seq int64
			if err := db.Transaction(func() error {
				var err error
				if seq, err = create("first"); err != nil {
					return err
				}
				// nested transaction은 바깥 operation id를 쓴다.
				return db.Transaction(func() error {
					c := byKey(seq)
					c.Set("title", "second")
					return c.Update(nil)
				}, orm.Retry(0))
			}, orm.Operation(int64(7)), orm.Retry(0)); err != nil {
				t.Fatal(err)
			}
			titled := byKey(seq)
			titled.Set("title", "third")
			if err := titled.Update(nil); orm.ErrorCode(err) != orm.CodeConfig {
				t.Fatalf("update without an operation id = %v, want CONFIG", err)
			}
			if err := db.Transaction(func() error { return byKey(seq).Delete(nil) }, orm.Operation(int64(8)), orm.Retry(0)); err != nil {
				t.Fatal(err)
			}

			got := readHistory(t, driver, dsn, sqlitePath)
			want := []historyRow{
				{change: "insert", seq: seq, title: "first", operation: 7},
				{change: "update", previous: sql.NullInt64{Int64: 7, Valid: true}, seq: seq, title: "second", operation: 7},
				{change: "update", previous: sql.NullInt64{Int64: 7, Valid: true}, seq: seq, title: "second", operation: 8, deleted: true},
			}
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Fatalf("history = %+v\nwant      %+v", got, want)
			}
		})
	}
}

// readHistory는 item_history를 history_id 순서로 native driver로 읽는다.
func readHistory(t *testing.T, driver, dsn, sqlitePath string) []historyRow {
	t.Helper()
	var raw *sql.DB
	if driver == "sqlite" {
		var err error
		if raw, err = sql.Open("sqlite", sqlitePath); err != nil {
			t.Fatal(err)
		}
	} else {
		raw = openNative(t, driver, dsn)
	}
	defer raw.Close()
	change := `"change"`
	if driver == "mysql" {
		change = "`change`"
	}
	rows, err := raw.Query(`SELECT ` + change + `, previous_operation_id, seq, title, operation_id, deleted_at IS NOT NULL FROM item_history ORDER BY history_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []historyRow
	for rows.Next() {
		var r historyRow
		if err := rows.Scan(&r.change, &r.previous, &r.seq, &r.title, &r.operation, &r.deleted); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}
