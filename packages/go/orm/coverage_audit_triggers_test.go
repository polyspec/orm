//go:build featurecoverage

package orm_test

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// featureDatabase is the database and DSN that the feature coverage checker selected.
// If either one is missing, the test fails.
func featureDatabase(t *testing.T) (string, string) {
	t.Helper()
	driver, dsn := os.Getenv("ORM_FEATURE_DATABASE"), os.Getenv("ORM_FEATURE_DSN")
	if dsn == "" || (driver != "mysql" && driver != "postgres" && driver != "sqlite") {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) and ORM_FEATURE_DSN are required")
	}
	return driver, dsn
}

// openFeatureNative opens the selected database with the native driver.
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

// sqliteFeaturePath is the file path of the SQLite DSN URI.
func sqliteFeaturePath(dsn string) string {
	path, _, _ := strings.Cut(strings.TrimPrefix(dsn, "sqlite://"), "?")
	return path
}

// auditTables holds the table names of the audit fixture in the selected database.
func auditTables(t *testing.T, raw *sql.DB, driver string) []string {
	t.Helper()
	query := map[string]string{
		"mysql":    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('audit', 'item', 'item_history') ORDER BY TABLE_NAME",
		"postgres": "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('audit', 'item', 'item_history') ORDER BY table_name",
		"sqlite":   "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('audit', 'item', 'item_history') ORDER BY name",
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

// dropAudit drops the tables and PostgreSQL trigger functions that the audit fixture created.
// Triggers are dropped along with their tables.
func dropAudit(t *testing.T, raw *sql.DB, driver string) {
	t.Helper()
	statements := map[string][]string{
		"mysql":  {"DROP TABLE IF EXISTS `item_history`", "DROP TABLE IF EXISTS `item`", "DROP TABLE IF EXISTS `audit`"},
		"sqlite": {`DROP TABLE IF EXISTS "item_history"`, `DROP TABLE IF EXISTS "item"`, `DROP TABLE IF EXISTS "audit"`},
		"postgres": {`DROP TABLE IF EXISTS "item_history"`, `DROP TABLE IF EXISTS "item"`, `DROP TABLE IF EXISTS "audit"`,
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

// TestCoverageAuditHistory runs auditCase on the selected database:
// it installs contracts/fixtures/audit.dbs, and on a connection with an audit source, the audit
// transaction inserts one audit record, and the audit table's insert, update, soft
// delete write that key, and whether the trigger records each version in item_history.
// It checks this and then drops the installed tables and functions.
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
	// It registers the cleanup before installing, so that partially applied installs are dropped too.
	defer dropAudit(t, raw, driver)
	auditCase(t, driver, dsn)
}

// TestCoverageAuditTransactionEntryPoints checks that every transaction entry point receives the audit
// value: the connection's Transaction and the WithContext handle's
// Transaction each insert one audit record (the audit source is called
// with the transaction's context), the audited write writes that key, and a nested transaction
// does not receive an audit.
func TestCoverageAuditTransactionEntryPoints(t *testing.T) {
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
	defer dropAudit(t, raw, driver)
	s := fixtureSchema(t, "audit")
	db, err := orm.ConnectSchema(dsn, s, auditConfig("default"))
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
	items := rowEntity("item", s, "seq", "title", "audit_seq", "deleted_at")
	item := func(conn *orm.DB, values map[string]any) *orm.Core {
		c := orm.NewCore(items)
		c.Connect(conn)
		for column, value := range values {
			c.Set(column, value)
		}
		return c
	}
	adb := db
	var seq int64
	if err := adb.Transaction(func() error {
		row, err := item(adb, map[string]any{"title": "first"}).Create()
		if err != nil {
			return err
		}
		seq = row.(*keywordRow).vals["seq"].(int64)
		return nil
	}, orm.Audit(map[string]any{"actor": "transaction"}), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	// The audit source is called with the context the transaction uses.
	handle := adb.WithContext(context.WithValue(context.Background(), actorKey{}, "context"))
	if err := handle.Transaction(func() error {
		return item(handle, map[string]any{"seq": seq, "title": "second"}).Update(nil)
	}, orm.Audit(nil), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	nested := adb.Transaction(func() error {
		return adb.Transaction(func() error { return nil }, orm.Audit(map[string]any{"actor": "nested"}))
	}, orm.Audit(nil), orm.Retry(0))
	if orm.ErrorCode(nested) != orm.CodeConfig {
		t.Fatalf("nested transaction with an audit = %v, want CONFIG", nested)
	}
	got := readHistory(t, driver, dsn)
	want := []historyRow{
		{change: "insert", seq: seq, title: "first", audit: 1},
		{change: "update", previous: sql.NullInt64{Int64: 1, Valid: true}, seq: seq, title: "second", audit: 2},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("history = %+v\nwant      %+v", got, want)
	}
	if rows := restoreTextRows(t, raw, "SELECT seq, actor FROM audit ORDER BY seq"); fmt.Sprint(rows) != "[[1 transaction] [2 context]]" {
		t.Fatalf("audit records = %v", rows)
	}
}

// auditColumnsTables is the table that the audit_columns fixture creates.
var auditColumnsTables = []string{"card", "card_history", "tag", "tag_history"}

// dropAuditColumns drops the table and PostgreSQL trigger that the audit_columns fixture created,
// function. Triggers are dropped along with their table.
func dropAuditColumns(t *testing.T, raw *sql.DB, driver string) {
	t.Helper()
	quote := func(name string) string { return `"` + name + `"` }
	if driver == "mysql" {
		quote = func(name string) string { return "`" + name + "`" }
	}
	var statements []string
	for _, table := range []string{"card_history", "card", "tag_history", "tag", "audit"} {
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

// auditColumnsRows reads the query's column names and all its rows as strings.
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

// TestCoverageAuditSelectedColumns installs contracts/fixtures/audit_columns.dbs in the selected
// database and checks that the audit trigger, on client insert, update, and soft delete,
// records only the selected columns. card omits secret with exclude (secret),
// and tag records only label and the audit column with include (label). The history table holds
// only the recorded columns. Afterward, it drops the installed tables and functions.
func TestCoverageAuditSelectedColumns(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, dsn := featureDatabase(t)
	raw := openFeatureNative(t, driver, dsn)
	defer func() {
		if err := raw.Close(); err != nil {
			t.Error(err)
		}
	}()
	// It registers the cleanup before installing, so that partially applied installs are dropped too.
	defer dropAuditColumns(t, raw, driver)

	s := fixtureSchema(t, "audit_columns")
	db, err := orm.ConnectSchema(dsn, s, auditConfig("default"))
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
	cards := rowEntity("card", s, "seq", "title", "secret", "audit_seq", "deleted_at")
	tags := rowEntity("tag", s, "id", "label", "color", "audit_seq")
	core := func(entity *orm.Entity, values map[string]any) *orm.Core {
		c := orm.NewCore(entity)
		c.Connect(db)
		for column, value := range values {
			c.Set(column, value)
		}
		return c
	}
	adb := db
	var seq, id int64
	if err := adb.Transaction(func() error {
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
	}, orm.Audit(map[string]any{"actor": "first"}), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	if err := adb.Transaction(func() error {
		if err := core(cards, map[string]any{"seq": seq}).Delete(nil); err != nil {
			return err
		}
		return core(tags, map[string]any{"id": id, "color": "blue"}).Update(nil)
	}, orm.Audit(map[string]any{"actor": "second"}), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}

	quote := map[bool]string{true: "`change`", false: `"change"`}[driver == "mysql"]
	columns, rows := auditColumnsRows(t, raw, "SELECT * FROM card_history ORDER BY history_id")
	if want := []string{"history_id", "change", "previous_audit_seq", "seq", "title", "audit_seq", "deleted_at"}; fmt.Sprint(columns) != fmt.Sprint(want) {
		t.Fatalf("card_history columns = %v, want %v", columns, want)
	}
	_, rows = auditColumnsRows(t, raw, "SELECT "+quote+", previous_audit_seq, seq, title, audit_seq, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END FROM card_history ORDER BY history_id")
	s1 := fmt.Sprint(seq)
	if want := [][]string{
		{"insert", "NULL", s1, "first", "1", "live"},
		{"update", "1", s1, "second", "1", "live"},
		{"update", "1", s1, "second", "2", "deleted"},
	}; fmt.Sprint(rows) != fmt.Sprint(want) {
		t.Fatalf("card_history = %v\nwant           %v", rows, want)
	}
	columns, _ = auditColumnsRows(t, raw, "SELECT * FROM tag_history ORDER BY history_id")
	if want := []string{"history_id", "change", "previous_audit_seq", "label", "audit_seq"}; fmt.Sprint(columns) != fmt.Sprint(want) {
		t.Fatalf("tag_history columns = %v, want %v", columns, want)
	}
	_, rows = auditColumnsRows(t, raw, "SELECT "+quote+", previous_audit_seq, label, audit_seq FROM tag_history ORDER BY history_id")
	if want := [][]string{{"insert", "NULL", "x", "1"}, {"update", "1", "x", "2"}}; fmt.Sprint(rows) != fmt.Sprint(want) {
		t.Fatalf("tag_history = %v\nwant          %v", rows, want)
	}
}

// dropRestore drops the table and PostgreSQL trigger function that the restore fixture created.
// Triggers are dropped along with their table.
func dropRestore(t *testing.T, raw *sql.DB, driver string) {
	t.Helper()
	quote := func(name string) string { return `"` + name + `"` }
	if driver == "mysql" {
		quote = func(name string) string { return "`" + name + "`" }
	}
	var statements []string
	for _, table := range []string{"membership_history", "membership", "label", "audit"} {
		statements = append(statements, "DROP TABLE IF EXISTS "+quote(table))
	}
	if driver == "postgres" {
		for _, event := range []string{"audit_insert", "audit_update", "audit_delete"} {
			statements = append(statements, `DROP FUNCTION IF EXISTS "membership$`+event+`"()`)
		}
	}
	for _, statement := range statements {
		if _, err := raw.Exec(statement); err != nil {
			t.Errorf("%s: %v", statement, err)
		}
	}
}

// TestCoverageSoftDeleteRestore runs restoreCase on the selected database:
// an audit table with a unique key and an exclude list, and a table without audit, soft
// deleted rows are restored. Afterward, it drops the installed tables and functions.
func TestCoverageSoftDeleteRestore(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, dsn := featureDatabase(t)
	raw := openFeatureNative(t, driver, dsn)
	defer func() {
		if err := raw.Close(); err != nil {
			t.Error(err)
		}
	}()
	for _, table := range restoreTables {
		if rows := restoreTextRows(t, raw, map[string]string{
			"mysql":    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '" + table + "'",
			"postgres": "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '" + table + "'",
			"sqlite":   "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '" + table + "'",
		}[driver]); rows[0][0] != "0" {
			t.Fatalf("table %s exists before the case", table)
		}
	}
	// It registers the cleanup before installing, so that partially applied installs are dropped too.
	defer dropRestore(t, raw, driver)
	restoreCase(t, driver, dsn)
}
