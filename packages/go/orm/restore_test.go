package orm_test

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// restoreTables is the table that contracts/fixtures/restore.dbs creates.
var restoreTables = []string{"audit", "label", "membership", "membership_history"}

// restoreNative opens the database at dsn with the native driver.
func restoreNative(t *testing.T, driver, dsn string) *sql.DB {
	t.Helper()
	if driver != "sqlite" {
		return openNative(t, driver, dsn)
	}
	path, _, _ := strings.Cut(strings.TrimPrefix(dsn, "sqlite://"), "?")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// restoreTextRows reads all rows of the query as strings. NULL is "NULL".
func restoreTextRows(t *testing.T, raw *sql.DB, query string) [][]string {
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
	return out
}

// restoreCase installs contracts/fixtures/restore.dbs in the database at dsn
// and restores the soft-deleted row. membership is an audit table with a unique key
// (team_id, member_id) and an exclude (note), and label is
// a table without audit that has the unique key (name). It checks:
//   - the unique key values of a soft-deleted row remain, so an insert of the same key
//     gives DUPLICATE_KEY.
//   - a default read does not read deleted rows.
//   - restore sends only the set values, finds the deleted row by the set values of one primary key or unique key the planner chose,
//     runs an update that writes the soft delete column as NULL, and
//     returns the restored row. Set values outside the key are the new values that the update writes along with it.
//     For an audit table, it writes the transaction's audit record key, and the trigger
//     records the update; without an audit it is CONFIG.
//   - restoring a row that was not deleted writes no new values and returns that row; restoring a row
//     that does not exist is NO_ROWS.
//   - a restore without key values is IR_INVALID, with no statement.
func restoreCase(t *testing.T, driver, dsn string) {
	t.Helper()
	s := fixtureSchema(t, "restore")
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
	raw := restoreNative(t, driver, dsn)
	defer func() {
		if err := raw.Close(); err != nil {
			t.Error(err)
		}
	}()
	// The audit record key differs per database, since a failed transaction may skip numbers
	// it wrote, so it is found by actor.
	auditSeq := func(actor string) string {
		rows := restoreTextRows(t, raw, "SELECT seq FROM audit WHERE actor = '"+actor+"'")
		if len(rows) != 1 {
			t.Fatalf("audit records of %s = %v, want one", actor, rows)
		}
		return rows[0][0]
	}
	adb := db
	memberships := rowEntity("membership", s, "seq", "team_id", "member_id", "note", "audit_seq", "deleted_at")
	labels := rowEntity("label", s, "id", "name", "color", "deleted_at")
	core := func(entity *orm.Entity, values map[string]any) *orm.Core {
		c := orm.NewCore(entity)
		c.Connect(db)
		for _, column := range []string{"seq", "id", "team_id", "member_id", "note", "name", "color"} {
			if value, ok := values[column]; ok {
				c.Set(column, value)
			}
		}
		return c
	}
	vals := func(m orm.Model) map[string]any { return m.(*keywordRow).vals }
	var seq, id int64
	if err := adb.Transaction(func() error {
		row, err := core(memberships, map[string]any{"team_id": int64(1), "member_id": int64(2), "note": "n1"}).Create()
		if err != nil {
			return err
		}
		seq = vals(row)["seq"].(int64)
		if row, err = core(labels, map[string]any{"name": "red", "color": "x"}).Create(); err != nil {
			return err
		}
		id = vals(row)["id"].(int64)
		return nil
	}, orm.Audit(map[string]any{"actor": "create"}), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	if err := adb.Transaction(func() error {
		if err := core(memberships, map[string]any{"seq": seq}).Delete(nil); err != nil {
			return err
		}
		return core(labels, map[string]any{"id": id}).Delete(nil)
	}, orm.Audit(map[string]any{"actor": "delete"}), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}

	duplicate := adb.Transaction(func() error {
		_, err := core(memberships, map[string]any{"team_id": int64(1), "member_id": int64(2)}).Create()
		return err
	}, orm.Audit(map[string]any{"actor": "duplicate"}), orm.Retry(0))
	if orm.ErrorCode(duplicate) != orm.CodeDuplicateKey {
		t.Fatalf("insert of the key of a soft-deleted row = %v, want DUPLICATE_KEY", duplicate)
	}
	read := core(labels, nil)
	read.Where("", []orm.ChainKey{{Column: "name"}}, "red")
	if row, err := read.Get(); row != nil || err != nil {
		t.Fatalf("default read of a soft-deleted row = %v, %v, want nil, nil", row, err)
	}
	if _, err := core(memberships, map[string]any{"team_id": int64(1), "member_id": int64(2)}).Restore(); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("restore of an audited row without an audit = %v, want CONFIG", err)
	}

	var restored, again orm.Model
	if err := adb.Transaction(func() error {
		var err error
		// Set values outside the key are the new values written together to the row being restored.
		restored, err = core(memberships, map[string]any{"team_id": int64(1), "member_id": int64(2), "note": "n2"}).Restore()
		return err
	}, orm.Audit(map[string]any{"actor": "restore"}), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	if got, want := fmt.Sprint(vals(restored)), fmt.Sprint(map[string]any{"seq": seq, "team_id": int64(1), "member_id": int64(2), "note": "n2", "audit_seq": mustSeq(t, auditSeq("restore")), "deleted_at": nil}); got != want {
		t.Fatalf("restored membership = %s, want %s", got, want)
	}
	if err := adb.Transaction(func() error {
		var err error
		again, err = core(memberships, map[string]any{"seq": seq, "note": "n3"}).Restore()
		return err
	}, orm.Audit(map[string]any{"actor": "again"}), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	if got, want := fmt.Sprint(vals(again)), fmt.Sprint(vals(restored)); got != want {
		t.Fatalf("restore of a row that is not deleted = %s, want the unchanged row %s", got, want)
	}

	label, err := core(labels, map[string]any{"name": "red", "color": "y"}).Restore()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := fmt.Sprint(vals(label)), fmt.Sprint(map[string]any{"id": id, "name": "red", "color": "y", "deleted_at": nil}); got != want {
		t.Fatalf("restored label = %s, want %s", got, want)
	}
	if _, err := core(labels, map[string]any{"name": "blue"}).Restore(); orm.ErrorCode(err) != orm.CodeNoRows {
		t.Fatalf("restore of an absent row = %v, want NO_ROWS", err)
	}
	if _, err := core(labels, map[string]any{"color": "x"}).Restore(); orm.ErrorCode(err) != orm.CodeIrInvalid {
		t.Fatalf("restore without the values of a key = %v, want IR_INVALID", err)
	}
	if _, err := core(labels, nil).Restore(); orm.ErrorCode(err) != orm.CodeIrInvalid {
		t.Fatalf("restore without key values = %v, want IR_INVALID", err)
	}

	change := map[bool]string{true: "`change`", false: `"change"`}[driver == "mysql"]
	history := restoreTextRows(t, raw, "SELECT "+change+", previous_audit_seq, seq, team_id, member_id, audit_seq, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END FROM membership_history ORDER BY history_id")
	s1 := fmt.Sprint(seq)
	if want := [][]string{
		{"insert", "NULL", s1, "1", "2", auditSeq("create"), "live"},
		{"update", auditSeq("create"), s1, "1", "2", auditSeq("delete"), "deleted"},
		{"update", auditSeq("delete"), s1, "1", "2", auditSeq("restore"), "live"},
	}; fmt.Sprint(history) != fmt.Sprint(want) {
		t.Fatalf("membership_history = %v\nwant                 %v", history, want)
	}
	if rows := restoreTextRows(t, raw, "SELECT COUNT(*) FROM audit WHERE actor = 'duplicate'"); rows[0][0] != "0" {
		t.Fatalf("audit records of the failed transaction = %s, want 0", rows[0][0])
	}
	if rows := restoreTextRows(t, raw, "SELECT COUNT(*) FROM label WHERE deleted_at IS NULL"); rows[0][0] != "1" {
		t.Fatalf("live labels = %s, want 1", rows[0][0])
	}
}

// mustSeq reads an integer text as int64.
func mustSeq(t *testing.T, text string) int64 {
	t.Helper()
	var n int64
	if _, err := fmt.Sscan(text, &n); err != nil {
		t.Fatalf("audit seq %q: %v", text, err)
	}
	return n
}

// TestRestoreSoftDeletedRow runs restoreCase on three databases, each case
// on a new database.
// Requirements: INT-38.
func TestRestoreSoftDeletedRow(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			start := time.Now()
			defer func() { t.Logf("end %s in %s", driver, time.Since(start)) }()
			restoreCase(t, driver, newDatabase(t, driver))
		})
	}
}
