//go:build featurecoverage

package orm_test

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

// featureDatabase는 feature coverage checker가 고른 database와 DSN이다.
// 둘 중 하나라도 없으면 test가 실패한다.
func featureDatabase(t *testing.T) (string, string) {
	t.Helper()
	driver, dsn := os.Getenv("ORM_FEATURE_DATABASE"), os.Getenv("ORM_FEATURE_DSN")
	if dsn == "" || (driver != "mysql" && driver != "postgres" && driver != "sqlite") {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) and ORM_FEATURE_DSN are required")
	}
	return driver, dsn
}

// openFeatureNative는 고른 database를 native driver로 연다.
func openFeatureNative(t *testing.T, driver, dsn string) *sql.DB {
	t.Helper()
	if driver != "sqlite" {
		return openNative(t, driver, dsn)
	}
	raw, err := sql.Open("sqlite", sqliteFeaturePath(dsn))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// sqliteFeaturePath는 SQLite DSN URI의 file path다.
func sqliteFeaturePath(dsn string) string {
	path, _, _ := strings.Cut(strings.TrimPrefix(dsn, "sqlite://"), "?")
	return path
}

// auditTables는 고른 database에 있는 audit fixture의 table 이름이다.
func auditTables(t *testing.T, raw *sql.DB, driver string) []string {
	t.Helper()
	query := map[string]string{
		"mysql":    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('item', 'item_history') ORDER BY TABLE_NAME",
		"postgres": "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('item', 'item_history') ORDER BY table_name",
		"sqlite":   "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('item', 'item_history') ORDER BY name",
	}[driver]
	rows, err := raw.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		out = append(out, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// dropAudit는 audit fixture가 만든 table과 PostgreSQL trigger function을
// 지운다. trigger는 table과 함께 지워진다.
func dropAudit(t *testing.T, raw *sql.DB, driver string) {
	t.Helper()
	statements := map[string][]string{
		"mysql":  {"DROP TABLE IF EXISTS `item_history`", "DROP TABLE IF EXISTS `item`"},
		"sqlite": {`DROP TABLE IF EXISTS "item_history"`, `DROP TABLE IF EXISTS "item"`},
		"postgres": {`DROP TABLE IF EXISTS "item_history"`, `DROP TABLE IF EXISTS "item"`,
			`DROP FUNCTION IF EXISTS "item$audit_insert"()`, `DROP FUNCTION IF EXISTS "item$audit_update"()`,
			`DROP FUNCTION IF EXISTS "item$audit_delete"()`},
	}[driver]
	for _, statement := range statements {
		if _, err := raw.Exec(statement); err != nil {
			t.Errorf("%s: %v", statement, err)
		}
	}
	if left := auditTables(t, raw, driver); len(left) > 0 {
		t.Errorf("audit tables remain after the drop: %v", left)
	}
}

// TestCoverageAuditHistory는 contracts/fixtures/audit.dbspec을 고른
// database에 설치하고, transaction의 operation id가 insert, update, soft
// delete의 operation column에 쓰이며 trigger가 각 version을 item_history에
// 남기는지 확인한다. 끝나면 설치한 table과 function을 지운다.
func TestCoverageAuditHistory(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, dsn := featureDatabase(t)
	raw := openFeatureNative(t, driver, dsn)
	defer func() {
		if err := raw.Close(); err != nil {
			t.Error(err)
		}
	}()
	if present := auditTables(t, raw, driver); len(present) > 0 {
		t.Fatalf("audit tables exist before the case: %v", present)
	}
	// 설치가 일부만 적용되어도 지우도록 설치 전에 정리를 등록한다.
	defer dropAudit(t, raw, driver)

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
	create := func(title string) (int64, error) {
		c := orm.NewCore(items)
		c.Connect(db)
		c.Set("title", title)
		row, err := c.Create()
		if err != nil {
			return 0, err
		}
		seq, ok := row.(*keywordRow).vals["seq"].(int64)
		if !ok {
			return 0, fmt.Errorf("created item seq has type %T", row.(*keywordRow).vals["seq"])
		}
		return seq, nil
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

	got := readHistory(t, driver, dsn, sqliteFeaturePath(dsn))
	want := []historyRow{
		{change: "insert", seq: seq, title: "first", operation: 7},
		{change: "update", previous: sql.NullInt64{Int64: 7, Valid: true}, seq: seq, title: "second", operation: 7},
		{change: "update", previous: sql.NullInt64{Int64: 7, Valid: true}, seq: seq, title: "second", operation: 8, deleted: true},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("history = %+v\nwant      %+v", got, want)
	}
}

// installedAudit은 고른 database에 contracts/fixtures/audit.dbs를 설치하고 연결,
// item entity, native 연결을 돌려준다. 설치한 table과 function은 case가 끝날 때
// 지운다.
func installedAudit(t *testing.T) (string, string, *orm.DB, *orm.Entity) {
	t.Helper()
	driver, dsn := featureDatabase(t)
	raw := openFeatureNative(t, driver, dsn)
	if present := auditTables(t, raw, driver); len(present) > 0 {
		t.Fatalf("audit tables exist before the case: %v", present)
	}
	// 설치가 일부만 적용되어도 지우도록 설치 전에 정리를 등록한다.
	t.Cleanup(func() {
		dropAudit(t, raw, driver)
		if err := raw.Close(); err != nil {
			t.Error(err)
		}
	})
	s := fixtureSchema(t, "audit")
	db, err := orm.ConnectSchema(dsn, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	if err := db.Utils().Schema().Install(s); err != nil {
		t.Fatal(err)
	}
	return driver, dsn, db, rowEntity("item", s, "seq", "title", "operation_id", "deleted_at")
}

// TestCoverageAuditOperationEntryPoints는 모든 transaction 진입점이 operation
// id를 받는지 확인한다: 연결의 Transaction과 WithContext handle의 Transaction이
// orm.Operation으로 정한 id를 audit 대상 write가 쓰고, 중첩 transaction은
// operation id를 받지 않는다.
func TestCoverageAuditOperationEntryPoints(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, dsn, db, items := installedAudit(t)
	item := func(conn *orm.DB, values map[string]any) *orm.Core {
		c := orm.NewCore(items)
		c.Connect(conn)
		for column, value := range values {
			c.Set(column, value)
		}
		return c
	}
	var seq int64
	if err := db.Transaction(func() error {
		row, err := item(db, map[string]any{"title": "first"}).Create()
		if err != nil {
			return err
		}
		seq = row.(*keywordRow).vals["seq"].(int64)
		return nil
	}, orm.Operation(int64(7)), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	handle := db.WithContext(context.Background())
	if err := handle.Transaction(func() error {
		return item(handle, map[string]any{"seq": seq, "title": "second"}).Update(nil)
	}, orm.Operation(int64(8)), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	nested := db.Transaction(func() error {
		return db.Transaction(func() error { return nil }, orm.Operation(int64(10)))
	}, orm.Operation(int64(9)), orm.Retry(0))
	if orm.ErrorCode(nested) != orm.CodeConfig {
		t.Fatalf("nested transaction with an operation id = %v, want CONFIG", nested)
	}
	got := readHistory(t, driver, dsn, sqliteFeaturePath(dsn))
	want := []historyRow{
		{change: "insert", seq: seq, title: "first", operation: 7},
		{change: "update", previous: sql.NullInt64{Int64: 7, Valid: true}, seq: seq, title: "second", operation: 8},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("history = %+v\nwant      %+v", got, want)
	}
}

// auditColumnsTables는 audit_columns fixture가 만드는 table이다.
var auditColumnsTables = []string{"card", "card_history", "tag", "tag_history"}

// dropAuditColumns는 audit_columns fixture가 만든 table과 PostgreSQL trigger
// function을 지운다. trigger는 table과 함께 지워진다.
func dropAuditColumns(t *testing.T, raw *sql.DB, driver string) {
	t.Helper()
	quote := func(name string) string { return `"` + name + `"` }
	if driver == "mysql" {
		quote = func(name string) string { return "`" + name + "`" }
	}
	var statements []string
	for _, table := range []string{"card_history", "card", "tag_history", "tag"} {
		statements = append(statements, "DROP TABLE IF EXISTS "+quote(table))
	}
	if driver == "postgres" {
		for _, table := range []string{"card", "tag"} {
			for _, event := range []string{"audit_insert", "audit_update", "audit_delete"} {
				statements = append(statements, `DROP FUNCTION IF EXISTS "`+table+"$"+event+`"()`)
			}
		}
	}
	for _, statement := range statements {
		if _, err := raw.Exec(statement); err != nil {
			t.Errorf("%s: %v", statement, err)
		}
	}
}

// auditColumnsRows는 query의 column 이름과 모든 row를 문자열로 읽는다.
func auditColumnsRows(t *testing.T, raw *sql.DB, query string) ([]string, [][]string) {
	t.Helper()
	rows, err := raw.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	var out [][]string
	for rows.Next() {
		values := make([]sql.NullString, len(columns))
		targets := make([]any, len(columns))
		for i := range values {
			targets[i] = &values[i]
		}
		if err := rows.Scan(targets...); err != nil {
			t.Fatal(err)
		}
		row := make([]string, len(columns))
		for i, v := range values {
			row[i] = "NULL"
			if v.Valid {
				row[i] = v.String
			}
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return columns, out
}

// TestCoverageAuditSelectedColumns는 contracts/fixtures/audit_columns.dbs를 고른
// database에 설치하고, client가 쓴 insert, update, soft delete를 audit trigger가
// 고른 column만으로 기록하는지 확인한다. card는 exclude (secret)로 secret을 빼고,
// tag는 include (label)로 label과 operation column만 기록한다. history table에는
// 기록하는 column만 있다. 끝나면 설치한 table과 function을 지운다.
func TestCoverageAuditSelectedColumns(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, dsn := featureDatabase(t)
	raw := openFeatureNative(t, driver, dsn)
	defer func() {
		if err := raw.Close(); err != nil {
			t.Error(err)
		}
	}()
	// 설치가 일부만 적용되어도 지우도록 설치 전에 정리를 등록한다.
	defer dropAuditColumns(t, raw, driver)

	s := fixtureSchema(t, "audit_columns")
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
	cards := rowEntity("card", s, "seq", "title", "secret", "operation_id", "deleted_at")
	tags := rowEntity("tag", s, "id", "label", "color", "operation_id")
	core := func(entity *orm.Entity, values map[string]any) *orm.Core {
		c := orm.NewCore(entity)
		c.Connect(db)
		for column, value := range values {
			c.Set(column, value)
		}
		return c
	}
	var seq, id int64
	if err := db.Transaction(func() error {
		row, err := core(cards, map[string]any{"title": "first", "secret": "s1"}).Create()
		if err != nil {
			return err
		}
		seq = row.(*keywordRow).vals["seq"].(int64)
		if row, err = core(tags, map[string]any{"label": "x", "color": "red"}).Create(); err != nil {
			return err
		}
		id = row.(*keywordRow).vals["id"].(int64)
		return core(cards, map[string]any{"seq": seq, "title": "second", "secret": "s2"}).Update(nil)
	}, orm.Operation(int64(7)), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	if err := db.Transaction(func() error {
		if err := core(cards, map[string]any{"seq": seq}).Delete(nil); err != nil {
			return err
		}
		return core(tags, map[string]any{"id": id, "color": "blue"}).Update(nil)
	}, orm.Operation(int64(8)), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}

	quote := map[bool]string{true: "`change`", false: `"change"`}[driver == "mysql"]
	columns, rows := auditColumnsRows(t, raw, "SELECT * FROM card_history ORDER BY history_id")
	if want := []string{"history_id", "change", "previous_operation_id", "seq", "title", "operation_id", "deleted_at"}; fmt.Sprint(columns) != fmt.Sprint(want) {
		t.Fatalf("card_history columns = %v, want %v", columns, want)
	}
	_, rows = auditColumnsRows(t, raw, "SELECT "+quote+", previous_operation_id, seq, title, operation_id, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END FROM card_history ORDER BY history_id")
	s1 := fmt.Sprint(seq)
	if want := [][]string{
		{"insert", "NULL", s1, "first", "7", "live"},
		{"update", "7", s1, "second", "7", "live"},
		{"update", "7", s1, "second", "8", "deleted"},
	}; fmt.Sprint(rows) != fmt.Sprint(want) {
		t.Fatalf("card_history = %v\nwant           %v", rows, want)
	}
	columns, _ = auditColumnsRows(t, raw, "SELECT * FROM tag_history ORDER BY history_id")
	if want := []string{"history_id", "change", "previous_operation_id", "label", "operation_id"}; fmt.Sprint(columns) != fmt.Sprint(want) {
		t.Fatalf("tag_history columns = %v, want %v", columns, want)
	}
	_, rows = auditColumnsRows(t, raw, "SELECT "+quote+", previous_operation_id, label, operation_id FROM tag_history ORDER BY history_id")
	if want := [][]string{{"insert", "NULL", "x", "7"}, {"update", "7", "x", "8"}}; fmt.Sprint(rows) != fmt.Sprint(want) {
		t.Fatalf("tag_history = %v\nwant          %v", rows, want)
	}
}
