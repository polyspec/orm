package orm_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// historyRow is one row of the audit history table.
type historyRow struct {
	change   string
	previous sql.NullInt64
	seq      int64
	title    string
	audit    int64
	deleted  bool
}

// auditSource is the audit source that supplies the actor as the audit value. From the context
// it uses the actorKey value if present.
func auditSource(actor string) func(context.Context) (map[string]any, error) {
	return func(ctx context.Context) (map[string]any, error) {
		if v, ok := ctx.Value(actorKey{}).(string); ok {
			return map[string]any{"actor": v}, nil
		}
		return map[string]any{"actor": actor}, nil
	}
}

// actorKey is the key of the context value that the audit source reads.
type actorKey struct{}

// auditConfig is the connection setting that supplies the actor as the audit value.
func auditConfig(actor string) orm.Config { return orm.Config{AuditSource: auditSource(actor)} }

// auditCase installs contracts/fixtures/audit.dbs in the database at dsn, and checks the audit
// records for the writes of the transaction that receives them.
//   - a record combining the value the connection setting's audit source gives with the transaction's audit value
//     one, which the transaction inserts into the audit setting's references table right before its first audited write
//     (for the same column the transaction's value wins), and the audit table's insert,
//     update, and soft delete write that primary key to the audit column; the trigger records each
//     version in the history table, and previous is the audit key of the prior version.
//   - an audit transaction on a connection with no audit source, where a column of the audit record table
//     that is not a value (of the transaction or the source) is CONFIG, and an error from the source is
//     a transaction error.
//   - a nested transaction uses the outer audit and does not receive its own (CONFIG).
//   - a write to an audit table without an audit is CONFIG. A raw
//     write that points to a missing audit record is refused by the foreign key.
//   - if the callback fails, the audit record is rolled back too.
//   - a transaction that writes no audited row (reads, an update that matches no row) inserts no
//     record, and a savepoint that rolls back the first audited write undoes its record.
func auditCase(t *testing.T, driver, dsn string) {
	t.Helper()
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
		t.Fatalf("insert without an audit = %v, want CONFIG", err)
	}
	for name, cfg := range map[string]orm.Config{
		"without an audit source": {},
		"with a source value that is no column": {AuditSource: func(context.Context) (map[string]any, error) {
			return map[string]any{"reason": "x"}, nil
		}},
	} {
		other, err := orm.ConnectSchema(dsn, s, cfg)
		if err != nil {
			t.Fatal(err)
		}
		err = other.Transaction(func() error { return nil }, orm.Audit(map[string]any{"actor": "x"}))
		other.Close()
		if orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("an audit transaction of a connection %s = %v, want CONFIG", name, err)
		}
	}
	unavailable := errors.New("no request")
	failing, err := orm.ConnectSchema(dsn, s, orm.Config{AuditSource: func(context.Context) (map[string]any, error) { return nil, unavailable }})
	if err != nil {
		t.Fatal(err)
	}
	err = failing.Transaction(func() error { return nil }, orm.Audit(nil))
	failing.Close()
	if !errors.Is(err, unavailable) {
		t.Fatalf("an audit transaction whose source fails = %v, want the source error", err)
	}
	adb := db
	if err := adb.Transaction(func() error { return nil }, orm.Audit(map[string]any{"reason": "x"})); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("an audit value that is no column = %v, want CONFIG", err)
	}
	var seq int64
	if err := adb.Transaction(func() error {
		var err error
		if seq, err = create("first"); err != nil {
			return err
		}
		nested := adb.Transaction(func() error { return nil }, orm.Audit(map[string]any{"actor": "nested"}))
		if orm.ErrorCode(nested) != orm.CodeConfig {
			return fmt.Errorf("a nested transaction with an audit = %v, want CONFIG", nested)
		}
		// A nested transaction uses the outer audit.
		return db.Transaction(func() error {
			c := byKey(seq)
			c.Set("title", "second")
			return c.Update(nil)
		}, orm.Retry(0))
	}, orm.Audit(map[string]any{"actor": "create"}), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	titled := byKey(seq)
	titled.Set("title", "third")
	if err := titled.Update(nil); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("update without an audit = %v, want CONFIG", err)
	}
	// An audit transaction with no values records only the defaults.
	if err := adb.Transaction(func() error { return byKey(seq).Delete(nil) }, orm.Audit(nil), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	failed := errors.New("callback failed")
	if err := adb.Transaction(func() error { return failed }, orm.Audit(map[string]any{"actor": "rolled back"}), orm.Retry(0)); !errors.Is(err, failed) {
		t.Fatalf("failed callback = %v", err)
	}

	raw := auditNative(t, driver, dsn)
	defer func() {
		if err := raw.Close(); err != nil {
			t.Error(err)
		}
	}()
	if _, err := raw.Exec("INSERT INTO item (title, audit_seq) VALUES ('raw', 999)"); err == nil {
		t.Fatal("a raw insert that names no audit record succeeded; the foreign key rejects it")
	}
	if got := fmt.Sprint(restoreTextRows(t, raw, "SELECT seq, actor FROM audit ORDER BY seq")); got != "[[1 create] [2 default]]" {
		t.Fatalf("audit records = %s, want [[1 create] [2 default]]", got)
	}
	got := readHistory(t, driver, dsn)
	want := []historyRow{
		{change: "insert", seq: seq, title: "first", audit: 1},
		{change: "update", previous: sql.NullInt64{Int64: 1, Valid: true}, seq: seq, title: "second", audit: 1},
		{change: "update", previous: sql.NullInt64{Int64: 1, Valid: true}, seq: seq, title: "second", audit: 2, deleted: true},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("history = %+v\nwant      %+v", got, want)
	}

	// The record is inserted right before the first audited write: a transaction of reads, or of an
	// update that matches no row, inserts none, and a rolled back savepoint undoes the record
	// with its write, so the next audited write inserts it again.
	actors := func() string {
		return fmt.Sprint(restoreTextRows(t, raw, "SELECT actor FROM audit ORDER BY seq"))
	}
	before := actors()
	if err := adb.Transaction(func() error {
		read := orm.NewCore(items)
		read.Connect(db)
		if _, err := read.GetCount(); err != nil {
			return err
		}
		missing := byKey(-1)
		missing.Set("title", "none")
		return missing.Update(nil)
	}, orm.Audit(map[string]any{"actor": "nothing"}), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	if got := actors(); got != before {
		t.Fatalf("a transaction that writes no audited row left audit records %s, want %s", got, before)
	}
	undone := errors.New("savepoint undone")
	if err := adb.Transaction(func() error {
		if err := adb.Transaction(func() error {
			if _, err := create("undone"); err != nil {
				return err
			}
			return undone
		}, orm.Retry(0)); !errors.Is(err, undone) {
			return fmt.Errorf("savepoint = %v, want the callback error", err)
		}
		_, err := create("kept")
		return err
	}, orm.Audit(map[string]any{"actor": "kept"}), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	if got, want := actors(), strings.TrimSuffix(before, "]")+" [kept]]"; got != want {
		t.Fatalf("audit records after a rolled back savepoint = %s, want %s", got, want)
	}
}

// auditNative opens the database at dsn with the native driver. SQLite turns foreign keys on
// per connection, so it opens with that pragma.
func auditNative(t *testing.T, driver, dsn string) *sql.DB {
	t.Helper()
	if driver != "sqlite" {
		return openNative(t, driver, dsn)
	}
	path, _, _ := strings.Cut(strings.TrimPrefix(dsn, "sqlite://"), "?")
	raw, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// TestAuditRecordTransaction runs auditCase on three databases, with a new
// database for each case.
func TestAuditRecordTransaction(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) { auditCase(t, driver, newDatabase(t, driver)) })
	}
}

// readHistory reads item_history in history_id order with the native driver.
func readHistory(t *testing.T, driver, dsn string) []historyRow {
	t.Helper()
	raw := restoreNative(t, driver, dsn)
	defer raw.Close()
	change := `"change"`
	if driver == "mysql" {
		change = "`change`"
	}
	rows, err := raw.Query(`SELECT ` + change + `, previous_audit_seq, seq, title, audit_seq, deleted_at IS NOT NULL FROM item_history ORDER BY history_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []historyRow
	for rows.Next() {
		var r historyRow
		if err := rows.Scan(&r.change, &r.previous, &r.seq, &r.title, &r.audit, &r.deleted); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}
