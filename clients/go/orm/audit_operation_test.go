package orm_test

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
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
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "audit")
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			start := time.Now()
			t.Logf("start %s", driver)
			defer func() { t.Logf("end %s in %s", driver, time.Since(start)) }()
			// 새 database라 이전 실행의 table, trigger, function이 남지 않는다.
			dsn := newDatabase(t, driver)
			sqlitePath := strings.TrimPrefix(dsn, "sqlite://")
			db, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(s); err != nil {
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

// setOperationCase는 dsn의 database에 contracts/fixtures/audit.dbs를 설치하고,
// 실행 중인 transaction에 Utils().SetOperation으로 operation id를 정한다.
//   - transaction 밖의 SetOperation과 int64나 string이 아닌 id는 CONFIG다.
//   - id를 정하기 전의 audit 대상 write는 CONFIG이고, 정한 뒤의 write는 그 id를
//     쓴다. 같은 id를 다시 정하면 아무것도 바뀌지 않고, 다른 id는 CONFIG다.
//   - 중첩 transaction은 바깥 id를 쓰며 다른 id를 정할 수 없다.
//   - id를 정한 savepoint가 rollback되면 savepoint가 시작할 때의 id로
//     돌아간다.
//   - transaction option으로 정한 id도 같은 규칙을 따른다.
func setOperationCase(t *testing.T, driver, dsn string) {
	t.Helper()
	s := fixtureSchema(t, "audit")
	db, err := orm.ConnectSchema(dsn, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	if err := db.Utils().Schema().Install(s); err != nil {
		t.Fatal(err)
	}
	items := rowEntity("item", s, "seq", "title", "operation_id", "deleted_at")
	item := func(values map[string]any) *orm.Core {
		c := orm.NewCore(items)
		for _, column := range []string{"seq", "title"} {
			if value, ok := values[column]; ok {
				c.Set(column, value)
			}
		}
		return c
	}
	want := func(what string, err error, code string) {
		t.Helper()
		if orm.ErrorCode(err) != code {
			t.Fatalf("%s = %v, want %s", what, err, code)
		}
	}
	want("SetOperation outside a transaction", db.Utils().SetOperation(int64(1)), orm.CodeConfig)

	var seq int64
	if err := db.Transaction(func() error {
		_, err := item(map[string]any{"title": "before"}).Create()
		want("an audited insert before SetOperation", err, orm.CodeConfig)
		want("SetOperation with an int", db.Utils().SetOperation(7), orm.CodeConfig)
		if err := db.Utils().SetOperation(int64(7)); err != nil {
			return err
		}
		row, err := item(map[string]any{"title": "first"}).Create()
		if err != nil {
			return err
		}
		seq = row.(*keywordRow).vals["seq"].(int64)
		if err := db.Utils().SetOperation(int64(7)); err != nil {
			return fmt.Errorf("the same operation id again: %w", err)
		}
		want("another operation id", db.Utils().SetOperation(int64(8)), orm.CodeConfig)
		return db.Transaction(func() error {
			want("another operation id in a nested transaction", db.Utils().SetOperation(int64(9)), orm.CodeConfig)
			return item(map[string]any{"seq": seq, "title": "second"}).Update(nil)
		}, orm.Retry(0))
	}, orm.Retry(0)); err != nil {
		t.Fatal(err)
	}

	rolledBack := errors.New("savepoint rolled back")
	if err := db.Transaction(func() error {
		nested := db.Transaction(func() error {
			if err := db.Utils().SetOperation(int64(10)); err != nil {
				return err
			}
			return rolledBack
		}, orm.Retry(0))
		if !errors.Is(nested, rolledBack) {
			return fmt.Errorf("nested transaction = %v", nested)
		}
		want("an audited update after the savepoint that set the id rolled back", item(map[string]any{"seq": seq, "title": "third"}).Update(nil), orm.CodeConfig)
		if err := db.Utils().SetOperation(int64(11)); err != nil {
			return err
		}
		return item(map[string]any{"seq": seq, "title": "third"}).Update(nil)
	}, orm.Retry(0)); err != nil {
		t.Fatal(err)
	}

	if err := db.Transaction(func() error {
		if err := db.Utils().SetOperation(int64(12)); err != nil {
			return fmt.Errorf("the option's operation id again: %w", err)
		}
		want("another id than the option's", db.Utils().SetOperation(int64(13)), orm.CodeConfig)
		return item(map[string]any{"seq": seq}).Delete(nil)
	}, orm.Operation(int64(12)), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}

	got := readHistory(t, driver, dsn, strings.TrimPrefix(strings.SplitN(dsn, "?", 2)[0], "sqlite://"))
	wantRows := []historyRow{
		{change: "insert", seq: seq, title: "first", operation: 7},
		{change: "update", previous: sql.NullInt64{Int64: 7, Valid: true}, seq: seq, title: "second", operation: 7},
		{change: "update", previous: sql.NullInt64{Int64: 7, Valid: true}, seq: seq, title: "third", operation: 11},
		{change: "update", previous: sql.NullInt64{Int64: 11, Valid: true}, seq: seq, title: "third", operation: 12, deleted: true},
	}
	if fmt.Sprint(got) != fmt.Sprint(wantRows) {
		t.Fatalf("history = %+v\nwant      %+v", got, wantRows)
	}
}

// TestSetOperationInTransaction는 setOperationCase를 세 database에서 case마다
// 새 database로 실행한다.
func TestSetOperationInTransaction(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) { setOperationCase(t, driver, newDatabase(t, driver)) })
	}
}
