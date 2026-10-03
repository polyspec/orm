package orm_test

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

// historyRow는 audit history table의 한 행이다.
type historyRow struct {
	change   string
	previous sql.NullInt64
	seq      int64
	title    string
	audit    int64
	deleted  bool
}

// auditOf는 schema s의 audit 기록 table audit에 actor를 쓴 새 model이다. 연결의
// audit 기본값으로 쓴다.
func auditOf(s *orm.Schema, actor string) orm.Model {
	ent := rowEntity("audit", s, "seq", "actor")
	c := orm.NewCore(ent)
	m := ent.New(c)
	c.Set("actor", actor)
	return m
}

// auditCase는 dsn의 database에 contracts/fixtures/audit.dbs를 설치하고, audit
// 기록을 받은 transaction의 write를 확인한다.
//   - handle의 audit 기본값과 transaction의 audit 값을 합친 기록 하나를
//     transaction이 callback 전에 삽입하고(같은 column이면 transaction 값이
//     이긴다), audit table의 insert, update, soft delete는 그 primary key를
//     audit column에 쓴다. trigger가 각 version을 history table에 남기고
//     previous는 이전 version의 audit key다.
//   - 기본값이 없는 연결의 audit transaction과 audit 기록 table의 column이 아닌
//     값은 CONFIG다.
//   - 중첩 transaction은 바깥 audit을 쓰며 자기 audit을 받지 않는다(CONFIG).
//   - audit 없는 audit table write는 CONFIG다. 없는 audit 기록을 가리키는 raw
//     write는 foreign key가 거부한다.
//   - callback이 실패하면 audit 기록도 rollback된다.
func auditCase(t *testing.T, driver, dsn string) {
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
	if err := db.Transaction(func() error { return nil }, orm.Audit(map[string]any{"actor": "x"})); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("an audit transaction of a connection without audit defaults = %v, want CONFIG", err)
	}
	adb := db.Audit(auditOf(s, "default"))
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
		// 중첩 transaction은 바깥 audit을 쓴다.
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
	// 값이 없는 audit transaction은 기본값만으로 기록한다.
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
}

// auditNative는 dsn의 database를 native driver로 연다. SQLite는 foreign key를
// 연결마다 켜므로 그 pragma로 연다.
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

// TestAuditRecordTransaction는 auditCase를 세 database에서 case마다 새
// database로 실행한다.
func TestAuditRecordTransaction(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) { auditCase(t, driver, newDatabase(t, driver)) })
	}
}

// readHistory는 item_history를 history_id 순서로 native driver로 읽는다.
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
