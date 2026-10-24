//go:build featurecoverage

package orm_test

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: PRT-2, PRT-34.
func TestHotPathReadCorrectness(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	path := filepath.Join(t.TempDir(), "hot-path.sqlite")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, raw)
	if _, err := raw.Exec(`CREATE TABLE author (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, service_seq INTEGER NOT NULL, is_close INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	insert, err := raw.Prepare(`INSERT INTO author (seq, name, service_seq, is_close) VALUES (?, ?, ?, ?)`)
	if err != nil {
		t.Fatal(err)
	}
	for seq := int64(1); seq <= 100; seq++ {
		if _, err := insert.Exec(seq, fmt.Sprintf("list-%03d", seq), 7, false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := insert.Exec(101, "closed", 7, true); err != nil {
		t.Fatal(err)
	}
	if _, err := insert.Exec(102, "other-service", 8, false); err != nil {
		t.Fatal(err)
	}
	if err := insert.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := model.Connect("sqlite://"+path, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)

	pk := model.Author().Connect(db).Seq(42).Limit(0, 1).RemoveAllColumns().RemoveColumnUserSeq().RemoveColumnServiceSeq().RemoveColumnServiceRegionSeq().RemoveColumnServiceMemberSeq().AddColumnSeq().AddColumnName()
	pkStatement, err := pk.GetQuery()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(pkStatement.Binds, []any{42, int64(1), int64(0)}) {
		t.Fatalf("PK binds = %#v, want []any{42, int64(1), int64(0)}", pkStatement.Binds)
	}
	assertProjection(t, pkStatement.SQL)
	assertExpectedRows(t, raw, pkStatement.SQL, pkStatement.Binds, [][2]any{{int64(42), "list-042"}})
	pkRows, err := pk.Gets()
	if err != nil {
		t.Fatal(err)
	}
	assertClientRows(t, pkRows, [][2]any{{int64(42), "list-042"}})

	list := model.Author().Connect(db).ServiceSeq(7).AndIsClose(false).OrderBySeqDesc().Limit(0, 100).RemoveAllColumns().RemoveColumnUserSeq().RemoveColumnServiceSeq().RemoveColumnServiceRegionSeq().RemoveColumnServiceMemberSeq().AddColumnSeq().AddColumnName()
	listStatement, err := list.GetQuery()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(listStatement.Binds, []any{7, false, int64(100), int64(0)}) {
		t.Fatalf("list100 binds = %#v, want []any{7, false, int64(100), int64(0)}", listStatement.Binds)
	}
	assertProjection(t, listStatement.SQL)
	want := make([][2]any, 0, 100)
	for seq := int64(100); seq >= 1; seq-- {
		want = append(want, [2]any{seq, fmt.Sprintf("list-%03d", seq)})
	}
	assertExpectedRows(t, raw, listStatement.SQL, listStatement.Binds, want)
	listRows, err := list.Gets()
	if err != nil {
		t.Fatal(err)
	}
	assertClientRows(t, listRows, want)
}

func assertProjection(t *testing.T, statement string) {
	t.Helper()
	projection := strings.SplitN(statement, " FROM ", 2)[0]
	if !strings.Contains(projection, `"a"."seq"`) || !strings.Contains(projection, `"a"."name"`) || strings.Contains(projection, "created_ts") {
		t.Fatalf("projection = %q, want only seq and name", projection)
	}
}

func assertExpectedRows(t *testing.T, db *sql.DB, statement string, binds []any, want [][2]any) {
	t.Helper()
	rows, err := db.Query(statement, binds...)
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, rows)
	got := make([][2]any, 0, len(want))
	for rows.Next() {
		var seq int64
		var name string
		if err := rows.Scan(&seq, &name); err != nil {
			t.Fatal(err)
		}
		got = append(got, [2]any{seq, name})
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("native rows = %#v, want %#v", got, want)
	}
}

func assertClientRows(t *testing.T, got *orm.Collection[*model.AuthorModel], want [][2]any) {
	t.Helper()
	values := testcase.SequenceNameRows(t, got)
	if !reflect.DeepEqual(values, want) {
		t.Fatalf("client rows = %#v, want %#v", values, want)
	}
}
