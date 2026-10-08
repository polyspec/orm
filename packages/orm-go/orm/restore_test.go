package orm_test

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

// restoreTables는 contracts/fixtures/restore.dbs가 만드는 table이다.
var restoreTables = []string{"audit", "label", "membership", "membership_history"}

// restoreNative는 dsn의 database를 native driver로 연다.
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

// restoreTextRows는 query의 모든 row를 문자열로 읽는다. NULL은 "NULL"이다.
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

// restoreCase는 dsn의 database에 contracts/fixtures/restore.dbs를 설치하고
// soft delete한 행을 restore로 되돌린다. membership은 unique key
// (team_id, member_id)와 exclude (note)를 가진 audit table이고 label은
// unique key (name)를 가진 audit 없는 table이다. 확인하는 것:
//   - soft delete한 행의 unique key 값은 남으므로 같은 key의 insert는
//     DUPLICATE_KEY다.
//   - 기본 read는 지운 행을 읽지 않는다.
//   - restore는 primary key나 unique key 하나의 set 값으로 지운 행을 찾아
//     soft delete column을 NULL로 쓰는 update를 하고, 되돌린 행을 돌려준다.
//     key 밖의 set 값은 그 update가 함께 쓰는 새 값이다.
//     audit table이면 transaction의 audit 기록 key를 쓰고 trigger가 그
//     update를 기록하며, audit이 없으면 CONFIG다.
//   - 지워지지 않은 행의 restore는 새 값도 쓰지 않고 그 행을 돌려주며, 없는
//     행의 restore는 NO_ROWS다.
//   - key의 값이 없는 restore는 CONFIG다.
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
	// audit 기록의 key는 실패한 transaction이 쓴 번호를 database마다 다르게
	// 건너뛸 수 있으므로 actor로 찾는다.
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
	if _, err := read.Get(); orm.ErrorCode(err) != orm.CodeNoRows {
		t.Fatalf("default read of a soft-deleted row = %v, want NO_ROWS", err)
	}
	if _, err := core(memberships, map[string]any{"team_id": int64(1), "member_id": int64(2)}).Restore(); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("restore of an audited row without an audit = %v, want CONFIG", err)
	}

	var restored, again orm.Model
	if err := adb.Transaction(func() error {
		var err error
		// key 밖의 set 값은 되돌리는 행에 함께 쓰는 새 값이다.
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
	if _, err := core(labels, map[string]any{"color": "x"}).Restore(); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("restore without the values of a key = %v, want CONFIG", err)
	}
	if _, err := core(labels, nil).Restore(); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("restore without key values = %v, want CONFIG", err)
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

// mustSeq는 정수 text를 int64로 읽는다.
func mustSeq(t *testing.T, text string) int64 {
	t.Helper()
	var n int64
	if _, err := fmt.Sscan(text, &n); err != nil {
		t.Fatalf("audit seq %q: %v", text, err)
	}
	return n
}

// TestRestoreSoftDeletedRow는 restoreCase를 세 database에서 case마다 새
// database로 실행한다.
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
