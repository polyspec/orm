package orm_test

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

// restoreTables는 contracts/fixtures/restore.dbs가 만드는 table이다.
var restoreTables = []string{"label", "membership", "membership_history"}

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
//     audit table이면 transaction의 operation id를 쓰고 trigger가 그 update를
//     기록하며, operation id가 없으면 CONFIG다.
//   - 지워지지 않은 행의 restore는 새 값도 쓰지 않고 그 행을 돌려주며, 없는
//     행의 restore는 NO_ROWS다.
//   - key의 값이 없는 restore는 CONFIG다.
func restoreCase(t *testing.T, driver, dsn string) {
	t.Helper()
	s := fixtureSchema(t, "restore")
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
	memberships := rowEntity("membership", s, "seq", "team_id", "member_id", "note", "operation_id", "deleted_at")
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
	if err := db.Transaction(func() error {
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
	}, orm.Operation(int64(1)), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	if err := db.Transaction(func() error {
		if err := core(memberships, map[string]any{"seq": seq}).Delete(nil); err != nil {
			return err
		}
		return core(labels, map[string]any{"id": id}).Delete(nil)
	}, orm.Operation(int64(2)), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}

	duplicate := db.Transaction(func() error {
		_, err := core(memberships, map[string]any{"team_id": int64(1), "member_id": int64(2)}).Create()
		return err
	}, orm.Operation(int64(3)), orm.Retry(0))
	if orm.ErrorCode(duplicate) != orm.CodeDuplicateKey {
		t.Fatalf("insert of the key of a soft-deleted row = %v, want DUPLICATE_KEY", duplicate)
	}
	read := core(labels, nil)
	read.Where("", []orm.ChainKey{{Column: "name"}}, "red")
	if _, err := read.Get(); orm.ErrorCode(err) != orm.CodeNoRows {
		t.Fatalf("default read of a soft-deleted row = %v, want NO_ROWS", err)
	}
	if _, err := core(memberships, map[string]any{"team_id": int64(1), "member_id": int64(2)}).Restore(); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("restore of an audited row without an operation id = %v, want CONFIG", err)
	}

	var restored, again orm.Model
	if err := db.Transaction(func() error {
		var err error
		// key 밖의 set 값은 되돌리는 행에 함께 쓰는 새 값이다.
		restored, err = core(memberships, map[string]any{"team_id": int64(1), "member_id": int64(2), "note": "n2"}).Restore()
		return err
	}, orm.Operation(int64(4)), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	if got, want := fmt.Sprint(vals(restored)), fmt.Sprint(map[string]any{"seq": seq, "team_id": int64(1), "member_id": int64(2), "note": "n2", "operation_id": int64(4), "deleted_at": nil}); got != want {
		t.Fatalf("restored membership = %s, want %s", got, want)
	}
	if err := db.Transaction(func() error {
		var err error
		again, err = core(memberships, map[string]any{"seq": seq, "note": "n3"}).Restore()
		return err
	}, orm.Operation(int64(5)), orm.Retry(0)); err != nil {
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

	raw := restoreNative(t, driver, dsn)
	defer func() {
		if err := raw.Close(); err != nil {
			t.Error(err)
		}
	}()
	change := map[bool]string{true: "`change`", false: `"change"`}[driver == "mysql"]
	history := restoreTextRows(t, raw, "SELECT "+change+", previous_operation_id, seq, team_id, member_id, operation_id, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END FROM membership_history ORDER BY history_id")
	s1 := fmt.Sprint(seq)
	if want := [][]string{
		{"insert", "NULL", s1, "1", "2", "1", "live"},
		{"update", "1", s1, "1", "2", "2", "deleted"},
		{"update", "2", s1, "1", "2", "4", "live"},
	}; fmt.Sprint(history) != fmt.Sprint(want) {
		t.Fatalf("membership_history = %v\nwant                 %v", history, want)
	}
	if rows := restoreTextRows(t, raw, "SELECT COUNT(*) FROM label WHERE deleted_at IS NULL"); rows[0][0] != "1" {
		t.Fatalf("live labels = %s, want 1", rows[0][0])
	}
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
