package orm_test

import (
	"errors"
	"github.com/polyspec/orm/internal/testcase"
	"path/filepath"
	"slices"
	"testing"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

// request hook의 공유 case다(docs/usage.md "Request hook"). contracts/fixtures/request_hook.dbs를 SQLite
// temp file에 설치하고 hook_item(id identity, part, label)과 soft delete table hook_entry(unique key part,
// label)에서 확인한다. hook은 request를 plan하기 직전에 받으며, client는 hook이 하는 일을 알지 못한다.

// hookFixture는 dsn의 database에 request_hook.dbs를 설치한 연결과 hook_item, hook_entry entity다. 연결은
// test가 끝나면 닫힌다. database를 만들고 지우는 일은 호출자가 한다.
func hookFixture(t *testing.T, dsn string) (*orm.DB, *orm.Entity, *orm.Entity) {
	t.Helper()
	s := fixtureSchema(t, "request_hook")
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
	return db, rowEntity("hook_item", s, "id", "part", "label"), rowEntity("hook_entry", s, "id", "part", "label", "note")
}

// hookEntry is a hook_entry model connected to db with values set.
func hookEntry(entry *orm.Entity, db *orm.DB, values map[string]any) *orm.Core {
	c := orm.NewCore(entry)
	entry.New(c)
	c.Connect(db)
	for _, column := range []string{"id", "part", "label", "note"} {
		if v, ok := values[column]; ok {
			c.Set(column, v)
		}
	}
	return c
}

// entryRows are the column values of the hook_entry rows that db reads, which are the rows not deleted.
func entryRows(t *testing.T, entry *orm.Entity, db *orm.DB) []map[string]any {
	t.Helper()
	rows, err := orm.Gets[*keywordRow](hookEntry(entry, db, nil))
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, r := range rows.Slice() {
		out = append(out, r.vals)
	}
	return out
}

// seedDeletedEntries creates the hook_entry rows (a, x), (b, x) and (a, y) with note n0 through db, soft
// deletes each and returns their ids by part and label.
func seedDeletedEntries(t *testing.T, entry *orm.Entity, db *orm.DB) map[string]any {
	t.Helper()
	ids := map[string]any{}
	for _, v := range [][2]string{{"a", "x"}, {"b", "x"}, {"a", "y"}} {
		row, err := hookEntry(entry, db, map[string]any{"part": v[0], "label": v[1], "note": "n0"}).Create()
		if err != nil {
			t.Fatal(err)
		}
		ids[v[0]+v[1]] = row.(*keywordRow).vals["id"]
		if err := row.Orm_().Delete(nil); err != nil {
			t.Fatal(err)
		}
	}
	return ids
}

// partScope adds part = value to the where of every read and restore.
func partScope(value string) orm.RequestHook {
	return func(r *ir.Request, addParam func(any) int, params []any) error {
		if r.Kind == "restore" || slices.Contains(hookReadKinds, r.Kind) {
			andWhere(&r.Query, partIs(addParam, value))
		}
		return nil
	}
}

// hookItem은 db에 연결한 hook_item model이고 values를 set한다. db가 nil이면 연결하지 않는다.
func hookItem(e *orm.Entity, db *orm.DB, values map[string]any) *orm.Core {
	c := orm.NewCore(e)
	e.New(c)
	if db != nil {
		c.Connect(db)
	}
	for _, column := range []string{"part", "label"} {
		if v, ok := values[column]; ok {
			c.Set(column, v)
		}
	}
	return c
}

// hookRows는 db로 읽은 모든 행의 column 값이다.
func hookRows(t *testing.T, e *orm.Entity, db *orm.DB) []map[string]any {
	t.Helper()
	rows, err := orm.Gets[*keywordRow](hookItem(e, db, nil))
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, r := range rows.Slice() {
		out = append(out, r.vals)
	}
	return out
}

func hookCount(t *testing.T, e *orm.Entity, db *orm.DB) int64 {
	t.Helper()
	n, err := hookItem(e, db, nil).GetCount()
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// seedHookItems는 연결로 a1, a2(part a)와 b1(part b)을 넣는다.
func seedHookItems(t *testing.T, e *orm.Entity, db *orm.DB) {
	t.Helper()
	for _, v := range [][2]string{{"a", "a1"}, {"a", "a2"}, {"b", "b1"}} {
		if _, err := hookItem(e, db, map[string]any{"part": v[0], "label": v[1]}).Create(); err != nil {
			t.Fatal(err)
		}
	}
}

// andWhere는 q의 where에 pred를 and로 더한다. 이미 있는 where는 group item 하나로 감싼다.
func andWhere(q *ir.Query, pred ir.Pred) {
	if q.Where == nil || len(q.Where.Items) == 0 {
		q.Where = &ir.Group{Items: []ir.Item{{Pred: &pred}}}
		return
	}
	pred.Conn = "and"
	q.Where = &ir.Group{Items: []ir.Item{{Group: q.Where}, {Pred: &pred}}}
}

func partIs(addParam func(any) int, value string) ir.Pred {
	p := addParam(value)
	return ir.Pred{Column: "part", Op: "eq", P: &p}
}

var hookReadKinds = []string{"one", "all", "count", "group_count", "sum", "avg", "paginate"}

// partFilter는 read에 part = value를 더하는 hook이다.
func partFilter(value string) orm.RequestHook {
	return func(r *ir.Request, addParam func(any) int, params []any) error {
		if slices.Contains(hookReadKinds, r.Kind) {
			andWhere(&r.Query, partIs(addParam, value))
		}
		return nil
	}
}

// requestHookCases는 공유 case ID마다 그 본문이다. 각 본문은 request_hook.dbs를 설치한 빈 database의 연결을 받는다.
var requestHookCases = []struct {
	id  string
	run func(t *testing.T, db *orm.DB, e, entry *orm.Entity)
}{
	{"without_hook", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		seedHookItems(t, e, db)
		if n := len(hookRows(t, e, db)); n != 3 {
			t.Fatalf("connection reads %d rows, want 3", n)
		}
		hooked := db.WithRequestHook(partFilter("a"))
		if hooked.Root() != db {
			t.Fatal("the hooked handle's Root is not the connection")
		}
		if n := len(hookRows(t, e, db)); n != 3 {
			t.Fatalf("connection after a hooked handle reads %d rows, want 3", n)
		}
		if n := hookCount(t, e, db); n != 3 {
			t.Fatalf("connection counts %d, want 3", n)
		}
	}},

	{"read_filter", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		seedHookItems(t, e, db)
		hooked := db.WithRequestHook(partFilter("a"))
		rows := hookRows(t, e, hooked)
		if len(rows) != 2 || rows[0]["part"] != "a" || rows[1]["part"] != "a" {
			t.Fatalf("hooked read = %v, want the two rows of part a", rows)
		}
		if n := hookCount(t, e, hooked); n != 2 {
			t.Fatalf("hooked count = %d, want 2", n)
		}
		page, err := orm.GetsPage[*keywordRow](hookItem(e, hooked, nil), 1, 10)
		if err != nil {
			t.Fatal(err)
		}
		if page.TotalCount != 2 || page.Items.Len() != 2 {
			t.Fatalf("hooked page total %d items %d, want 2 and 2", page.TotalCount, page.Items.Len())
		}
		// 다른 값의 hook은 같은 plan을 쓰고 자기 값으로 거른다.
		if n := len(hookRows(t, e, db.WithRequestHook(partFilter("b")))); n != 1 {
			t.Fatalf("hook with b reads %d rows, want 1", n)
		}
		st, err := hookItem(e, hooked, nil).GetQuery()
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(st.Binds, any("a")) {
			t.Fatalf("hooked getQuery binds %v carry no a", st.Binds)
		}
	}},

	{"reads_params", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		// The hook reads the value that the model bound to the assignment of the insert, on a copy of the parameters.
		var seen any
		hooked := db.WithRequestHook(func(r *ir.Request, addParam func(any) int, params []any) error {
			if r.Kind == "insert" {
				for _, a := range r.Set {
					if a.Column == "label" && a.P != nil {
						seen = params[*a.P]
						params[*a.P] = "changed"
					}
				}
			}
			return nil
		})
		if _, err := hookItem(e, hooked, map[string]any{"part": "r", "label": "read"}).Create(); err != nil {
			t.Fatal(err)
		}
		if seen != "read" {
			t.Fatalf("the hook read %v, want read", seen)
		}
		stored := false
		for _, row := range hookRows(t, e, db) {
			stored = stored || row["label"] == "read"
		}
		if !stored {
			t.Fatal("a change of the parameters that the hook reads reached the request")
		}
	}},

	{"insert_assign", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		hooked := db.WithRequestHook(func(r *ir.Request, addParam func(any) int, params []any) error {
			if r.Kind != "insert" {
				return nil
			}
			p := addParam("h")
			r.Set = append(r.Set, ir.Assign{Column: "part", P: &p})
			for i := range r.Rows {
				r.Rows[i] = append(r.Rows[i], addParam("h"))
			}
			return nil
		})
		if _, err := hookItem(e, hooked, map[string]any{"label": "single"}).Create(); err != nil {
			t.Fatal(err)
		}
		bulk := []*keywordRow{}
		for _, label := range []string{"bulk1", "bulk2"} {
			bulk = append(bulk, hookItem(e, nil, map[string]any{"label": label}).Self().(*keywordRow))
		}
		if n, err := orm.Creates(hookItem(e, hooked, nil), bulk); err != nil || n != 2 {
			t.Fatalf("bulk create = %d, %v; want 2 rows", n, err)
		}
		rows := hookRows(t, e, db)
		if len(rows) != 3 {
			t.Fatalf("connection reads %d rows, want 3", len(rows))
		}
		for _, row := range rows {
			if row["part"] != "h" {
				t.Fatalf("row %v has no part h", row)
			}
		}
	}},

	{"loaded_row_writes", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		seedHookItems(t, e, db)
		var kinds []string
		hooked := db.WithRequestHook(func(r *ir.Request, addParam func(any) int, params []any) error {
			kinds = append(kinds, r.Kind)
			if r.Kind == "update" || r.Kind == "delete" {
				andWhere(&r.Query, partIs(addParam, "none"))
			}
			return nil
		})
		read := hookItem(e, hooked, nil)
		read.Where("", []orm.ChainKey{{Column: "label"}}, "a1")
		row, err := read.Get()
		if err != nil {
			t.Fatal(err)
		}
		row.Orm_().Set("label", "changed")
		if err := row.Orm_().Update(nil); err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(kinds, "update") {
			t.Fatalf("hook saw %v, want an update", kinds)
		}
		for _, r := range hookRows(t, e, db) {
			if r["label"] == "changed" {
				t.Fatal("the update outside the hook predicate changed the row")
			}
		}
		if err := row.Orm_().Delete(nil); err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(kinds, "delete") {
			t.Fatalf("hook saw %v, want a delete", kinds)
		}
		if n := hookCount(t, e, db); n != 3 {
			t.Fatalf("connection counts %d after the hooked delete, want 3", n)
		}
		// hooked handle에서 시작한 transaction 안의 연결 없는 model은 그 hook을 지난다.
		kinds = nil
		if err := hooked.Transaction(func() error {
			_, err := orm.Gets[*keywordRow](hookItem(e, nil, nil))
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(kinds, []string{"all"}) {
			t.Fatalf("hook saw %v in the transaction, want [all]", kinds)
		}
	}},

	{"invalid_param", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		hooked := db.WithRequestHook(func(r *ir.Request, addParam func(any) int, params []any) error {
			p := r.NParams + 5
			andWhere(&r.Query, ir.Pred{Column: "part", Op: "eq", P: &p})
			return nil
		})
		statements := 0
		unsubscribe, err := db.Subscribe(func(orm.StatementEvent) error { statements++; return nil })
		if err != nil {
			t.Fatal(err)
		}
		defer unsubscribe()
		_, err = hookItem(e, hooked, nil).GetCount()
		if orm.ErrorCode(err) != orm.CodeIrInvalid {
			t.Fatalf("count with an invalid param = %v, want IR_INVALID", err)
		}
		if statements != 0 {
			t.Fatalf("%d statements ran, want none", statements)
		}
		// hook의 오류는 그대로 돌아온다.
		failing := errors.New("hook refused")
		_, err = hookItem(e, db.WithRequestHook(func(*ir.Request, func(any) int, []any) error { return failing }), nil).GetCount()
		if !errors.Is(err, failing) || statements != 0 {
			t.Fatalf("count with a failing hook = %v after %d statements, want the hook error and none", err, statements)
		}
	}},

	{"restore_key", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		ids := seedDeletedEntries(t, entry, db)
		// The set names label, the hook's condition names part: together they cover the unique key.
		row, err := hookEntry(entry, db.WithRequestHook(partScope("a")), map[string]any{"label": "x", "note": "n1"}).Restore()
		if err != nil {
			t.Fatal(err)
		}
		vals := row.(*keywordRow).vals
		if vals["id"] != ids["ax"] || vals["part"] != "a" || vals["label"] != "x" || vals["note"] != "n1" {
			t.Fatalf("restore returned %v, want (a, x) with note n1", vals)
		}
		rows := entryRows(t, entry, db)
		if len(rows) != 1 || rows[0]["id"] != ids["ax"] || rows[0]["note"] != "n1" {
			t.Fatalf("connection reads %v, want only (a, x) with note n1", rows)
		}
	}},

	{"restore_condition", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		ids := seedDeletedEntries(t, entry, db)
		// The set names the primary key; the hook's condition part = b excludes the row of part a.
		_, err := hookEntry(entry, db.WithRequestHook(partScope("b")), map[string]any{"id": ids["ay"], "note": "n2"}).Restore()
		if orm.ErrorCode(err) != orm.CodeNoRows {
			t.Fatalf("restore outside the hook condition = %v, want NO_ROWS", err)
		}
		if rows := entryRows(t, entry, db); len(rows) != 0 {
			t.Fatalf("connection reads %v after the restore outside the hook condition, want no row", rows)
		}
		row, err := hookEntry(entry, db.WithRequestHook(partScope("a")), map[string]any{"id": ids["ay"], "note": "n2"}).Restore()
		if err != nil {
			t.Fatal(err)
		}
		if vals := row.(*keywordRow).vals; vals["id"] != ids["ay"] || vals["label"] != "y" || vals["note"] != "n2" {
			t.Fatalf("restore returned %v, want (a, y) with note n2", vals)
		}
	}},

	{"restore_no_key", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		seedDeletedEntries(t, entry, db)
		statements := 0
		unsubscribe, err := db.Subscribe(func(orm.StatementEvent) error { statements++; return nil })
		if err != nil {
			t.Fatal(err)
		}
		defer unsubscribe()
		// part from the hook and no label cover no key.
		_, err = hookEntry(entry, db.WithRequestHook(partScope("a")), map[string]any{"note": "n3"}).Restore()
		if orm.ErrorCode(err) != orm.CodeIrInvalid {
			t.Fatalf("restore without a key = %v, want IR_INVALID", err)
		}
		if statements != 0 {
			t.Fatalf("%d statements ran, want none", statements)
		}
	}},

	{"restore_rewritten_key", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		ids := seedDeletedEntries(t, entry, db)
		// The hook scopes the restore to part a and gives the model's label its own value y.
		scope := partScope("a")
		hooked := db.WithRequestHook(func(r *ir.Request, addParam func(any) int, params []any) error {
			if r.Kind == "restore" {
				for i := range r.Set {
					if r.Set[i].Column == "label" {
						p := addParam("y")
						r.Set[i].P = &p
					}
				}
			}
			return scope(r, addParam, params)
		})
		row, err := hookEntry(entry, hooked, map[string]any{"label": "x", "note": "n4"}).Restore()
		if err != nil {
			t.Fatal(err)
		}
		if vals := row.(*keywordRow).vals; vals["id"] != ids["ay"] || vals["label"] != "y" || vals["note"] != "n4" {
			t.Fatalf("restore returned %v, want (a, y) with note n4", vals)
		}
		if rows := entryRows(t, entry, db); len(rows) != 1 || rows[0]["id"] != ids["ay"] || rows[0]["note"] != "n4" {
			t.Fatalf("connection reads %v, want only (a, y) with note n4", rows)
		}
	}},

	{"restore_hook_set_key", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		ids := seedDeletedEntries(t, entry, db)
		// The hook puts part a first in the set; the model's label completes the unique key.
		hooked := db.WithRequestHook(func(r *ir.Request, addParam func(any) int, params []any) error {
			if r.Kind == "restore" {
				p := addParam("a")
				r.Set = append([]ir.Assign{{Column: "part", P: &p}}, r.Set...)
			}
			return nil
		})
		row, err := hookEntry(entry, hooked, map[string]any{"label": "x", "note": "n5"}).Restore()
		if err != nil {
			t.Fatal(err)
		}
		if vals := row.(*keywordRow).vals; vals["id"] != ids["ax"] || vals["part"] != "a" || vals["note"] != "n5" {
			t.Fatalf("restore returned %v, want (a, x) with note n5", vals)
		}
		if rows := entryRows(t, entry, db); len(rows) != 1 || rows[0]["id"] != ids["ax"] || rows[0]["note"] != "n5" {
			t.Fatalf("connection reads %v, want only (a, x) with note n5", rows)
		}
	}},
}

// TestRequestHook은 각 case를 SQLite temp file에서 실행한다. file은 test가 끝나면 지워진다.
func TestRequestHook(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, c := range requestHookCases {
		t.Run(c.id, func(t *testing.T) {
			db, e, entry := hookFixture(t, "sqlite://"+filepath.Join(t.TempDir(), "request_hook.sqlite"))
			c.run(t, db, e, entry)
		})
	}
}
