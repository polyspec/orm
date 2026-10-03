//go:build featurecoverage

package orm_test

import (
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
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
