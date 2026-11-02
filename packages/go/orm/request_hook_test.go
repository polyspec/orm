package orm_test

import (
	"cmp"
	"errors"
	"fmt"
	"github.com/polyspec/orm/packages/go/testcase"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/internal/irwhere"
	"github.com/polyspec/orm/packages/go/orm"
)

// A shared case for the request hook (docs/operations/usage.md "Request hook"). It installs contracts/fixtures/request_hook/request_hook.dbs in a SQLite
// temp file and checks hook_item(id identity, part, label) and the soft delete table hook_entry(unique key part,
// label). The hook receives the request just before it is planned, and the client does not know what the hook does.

// hookFixture is the connection with request_hook.dbs installed on the database at dsn, and the hook_item and hook_entry entities. The connection
// is closed when the test ends. Creating and dropping the database is up to the caller.
func hookFixture(t *testing.T, dsn string) (*orm.DB, *orm.Entity, *orm.Entity) {
	t.Helper()
	s := fixtureSchema(t, "request_hook/request_hook")
	db := connectSchemaDB(t, dsn, s)
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
	return rowVals(t, rows, err)
}

// rowVals returns the column values of the rows of a read; a failed read fails the test.
func rowVals(t *testing.T, rows *orm.Collection[*keywordRow], err error) []map[string]any {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, r := range rows.Slice() {
		out = append(out, r.vals)
	}
	return out
}

// restoreLabel gives the label column of a restore request the bound value of value (the hook's own).
func restoreLabel(r *ir.Request, addParam func(any) int, value string) {
	for i := range r.Set {
		if r.Set[i].Column == "label" {
			p := addParam(value)
			r.Set[i].P = &p
		}
	}
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
		ids[v[0]+v[1]] = as[*keywordRow](t, row).vals["id"]
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
			irwhere.And(&r.Query, partIs(addParam, value))
		}
		return nil
	}
}

// serviceScope is a service scope: it adds part = value to the where of the root of every read and of each of its
// relation queries, nested relations included, as an application scopes every table of a request.
func serviceScope(value string) orm.RequestHook {
	var scope func(q *ir.Query, addParam func(any) int)
	scope = func(q *ir.Query, addParam func(any) int) {
		irwhere.And(q, partIs(addParam, value))
		for _, rel := range q.Relations {
			scope(rel.Query, addParam)
		}
	}
	return func(r *ir.Request, addParam func(any) int, params []any) error {
		if slices.Contains(hookReadKinds, r.Kind) {
			scope(&r.Query, addParam)
		}
		return nil
	}
}

// hookItem is a hook_item model connected to db, with its values set. If db is nil, it does not connect.
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

// hookRows holds the column values of all the rows read from db.
func hookRows(t *testing.T, e *orm.Entity, db *orm.DB) []map[string]any {
	t.Helper()
	rows, err := orm.Gets[*keywordRow](hookItem(e, db, nil))
	return rowVals(t, rows, err)
}

func hookCount(t *testing.T, e *orm.Entity, db *orm.DB) int64 {
	t.Helper()
	n, err := hookItem(e, db, nil).GetCount()
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// seedHookItems inserts a1 and a2 (part a) and b1 (part b) through the connection.
func seedHookItems(t *testing.T, e *orm.Entity, db *orm.DB) {
	t.Helper()
	for _, v := range [][2]string{{"a", "a1"}, {"a", "a2"}, {"b", "b1"}} {
		if _, err := hookItem(e, db, map[string]any{"part": v[0], "label": v[1]}).Create(); err != nil {
			t.Fatal(err)
		}
	}
}

func partIs(addParam func(any) int, value string) ir.Pred {
	p := addParam(value)
	return ir.Pred{Column: "part", Op: "eq", P: &p}
}

var hookReadKinds = []string{"one", "all", "count", "group_count", "sum", "avg", "paginate"}

// partFilter is a hook that adds part = value to a read.
func partFilter(value string) orm.RequestHook {
	return func(r *ir.Request, addParam func(any) int, params []any) error {
		if slices.Contains(hookReadKinds, r.Kind) {
			irwhere.And(&r.Query, partIs(addParam, value))
		}
		return nil
	}
}

// requestHookCases holds the body of each shared case ID. Each body receives a connection to an empty database with request_hook.dbs installed.
var requestHookCases = []struct {
	id  string
	run func(t *testing.T, db *orm.DB, e, entry *orm.Entity)
}{
	{"without_hook", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		// The recipe checks the rows and counts of the connection; this checks the Root of the hooked handle, which a step cannot observe.
		seedHookItems(t, e, db)
		hooked := db.WithRequestHook(partFilter("a"))
		if hooked.Root() != db {
			t.Fatal("the hooked handle's Root is not the connection")
		}
	}},

	{"read_filter", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		// The recipe checks the rows of the hooked reads; this checks that the planned getQuery binds the hook's value, which a step cannot observe.
		seedHookItems(t, e, db)
		hooked := db.WithRequestHook(partFilter("a"))
		st, err := hookItem(e, hooked, nil).GetQuery()
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(st.Binds, any("a")) {
			t.Fatalf("hooked getQuery binds %v carry no a", st.Binds)
		}
	}},

	{"relation_scope", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		// The recipe checks the scoped relation with the child read on the hooked connection; this checks the second child
		// handle, the unhooked connection's child, which a step cannot observe.
		seedHookItems(t, e, db)
		if _, err := hookItem(e, db, map[string]any{"part": "b", "label": "a1"}).Create(); err != nil {
			t.Fatal(err)
		}
		for _, v := range [][2]string{{"a", "a1"}, {"b", "b1"}} {
			if _, err := hookEntry(entry, db, map[string]any{"part": v[0], "label": v[1]}).Create(); err != nil {
				t.Fatal(err)
			}
		}
		read := func(handle *orm.DB, many bool, child *orm.Core) []*keywordRow {
			t.Helper()
			parent := hookEntry(entry, handle, nil)
			parent.Where("", []orm.ChainKey{{Column: "label"}}, "a1")
			child.Match("label", "label")
			parent.Relation(many, child.Self())
			rows, err := orm.Gets[*keywordRow](parent)
			if err != nil {
				t.Fatal(err)
			}
			return rows.Slice()
		}
		parts := func(rows []*keywordRow) []string {
			var out []string
			for _, r := range rows {
				out = append(out, fmt.Sprintf("%v/%v", r.vals["part"], r.vals["label"]))
			}
			slices.Sort(out)
			return out
		}
		children := func(row *keywordRow) []*keywordRow {
			t.Helper()
			c, err := orm.RelatedAs[*orm.Collection[*keywordRow]](row.m, "hook_item_models")
			if err != nil || c == nil {
				t.Fatalf("hook_item_models: %v, %v", c, err)
			}
			return c.Slice()
		}
		scoped := db.WithRequestHook(serviceScope("a"))
		many := read(scoped, true, hookItem(e, nil, nil))
		if len(many) != 1 || many[0].vals["label"] != "a1" || !slices.Equal(parts(children(many[0])), []string{"a/a1"}) {
			t.Fatalf("relations() under the scope of part a reads %d parents, want the parent a1 with the item a/a1", len(many))
		}
		one := read(scoped, false, hookItem(e, nil, nil))
		if len(one) != 1 || one[0].vals["label"] != "a1" {
			t.Fatalf("relation() under the scope of part a reads %d parents, want the parent a1", len(one))
		}
		attached, err := orm.RelatedAs[*keywordRow](one[0].m, "hook_item_model")
		if err != nil || attached == nil || attached.vals["part"] != "a" {
			t.Fatalf("relation() under the scope of part a attaches %v (%v), want the item of part a", attached, err)
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

	{"invalid_param", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		hooked := db.WithRequestHook(func(r *ir.Request, addParam func(any) int, params []any) error {
			p := r.NParams + 5
			irwhere.And(&r.Query, ir.Pred{Column: "part", Op: "eq", P: &p})
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
		// A hook's error is returned as is.
		failing := errors.New("hook refused")
		_, err = hookItem(e, db.WithRequestHook(func(*ir.Request, func(any) int, []any) error { return failing }), nil).GetCount()
		if !errors.Is(err, failing) || statements != 0 {
			t.Fatalf("count with a failing hook = %v after %d statements, want the hook error and none", err, statements)
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
				restoreLabel(r, addParam, "y")
			}
			return scope(r, addParam, params)
		})
		row, err := hookEntry(entry, hooked, map[string]any{"label": "x", "note": "n4"}).Restore()
		if err != nil {
			t.Fatal(err)
		}
		if vals := as[*keywordRow](t, row).vals; vals["id"] != ids["ay"] || vals["label"] != "y" || vals["note"] != "n4" {
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
		if vals := as[*keywordRow](t, row).vals; vals["id"] != ids["ax"] || vals["part"] != "a" || vals["note"] != "n5" {
			t.Fatalf("restore returned %v, want (a, x) with note n5", vals)
		}
		if rows := entryRows(t, entry, db); len(rows) != 1 || rows[0]["id"] != ids["ax"] || rows[0]["note"] != "n5" {
			t.Fatalf("connection reads %v, want only (a, x) with note n5", rows)
		}
	}},
	{"restore_rewritten_key_set_scope", func(t *testing.T, db *orm.DB, e, entry *orm.Entity) {
		ids := seedDeletedEntries(t, entry, db)
		// The hook gives the model's label its own value y and sets part a after it, with no where parameter.
		hooked := db.WithRequestHook(func(r *ir.Request, addParam func(any) int, params []any) error {
			if r.Kind == "restore" {
				restoreLabel(r, addParam, "y")
				p := addParam("a")
				r.Set = append(r.Set, ir.Assign{Column: "part", P: &p})
			}
			return nil
		})
		row, err := hookEntry(entry, hooked, map[string]any{"label": "x", "note": "n6"}).Restore()
		if err != nil {
			t.Fatal(err)
		}
		if vals := as[*keywordRow](t, row).vals; vals["id"] != ids["ay"] || vals["label"] != "y" || vals["note"] != "n6" {
			t.Fatalf("restore returned %v, want (a, y) with note n6", vals)
		}
		if rows := entryRows(t, entry, db); len(rows) != 1 || rows[0]["id"] != ids["ay"] || rows[0]["note"] != "n6" {
			t.Fatalf("connection reads %v, want only (a, y) with note n6", rows)
		}
	}},
}

// TestRequestHook runs each case in a SQLite temp file. The file is removed when the test ends.
func TestRequestHook(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, c := range requestHookCases {
		t.Run(c.id, func(t *testing.T) {
			db, e, entry := hookFixture(t, "sqlite://"+filepath.Join(t.TempDir(), "request_hook.sqlite"))
			c.run(t, db, e, entry)
		})
	}
}

// TestCreatesParts checks the multi-row insert rules of docs/spec/protocol.md through the model path. creates splits the rows
// into batches of the given size and runs them in the given order in one transaction: each batch is one INSERT,
// rows, keys, and statement events keep the given order, a batch that is not positive is CONFIG and a batch over the
// bind limit is BATCH_TOO_LARGE before any statement, and if any batch fails, no rows remain.
func TestCreatesParts(t *testing.T) {
	testcase.Start(t, testcase.Database)
	inserts := func(t *testing.T, db *orm.DB) *[]orm.StatementEvent {
		t.Helper()
		var seen []orm.StatementEvent
		unsubscribe, err := db.Subscribe(func(e orm.StatementEvent) error {
			seen = append(seen, e)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(unsubscribe)
		return &seen
	}
	batch := func(e *orm.Entity, labels []string) []*keywordRow {
		rows := []*keywordRow{}
		for _, label := range labels {
			rows = append(rows, as[*keywordRow](t, hookItem(e, nil, map[string]any{"part": "p", "label": label}).Self()))
		}
		return rows
	}
	labels := func(n int) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = fmt.Sprintf("r%02d", i)
		}
		return out
	}
	t.Run("refused", func(t *testing.T) {
		db, e, _ := hookFixture(t, "sqlite://"+filepath.Join(t.TempDir(), "parts.sqlite"))
		seen := inserts(t, db)
		for _, size := range []int{0, -1} {
			if _, err := orm.Creates(hookItem(e, db, nil), batch(e, labels(3)), size); orm.ErrorCode(err) != orm.CodeConfig {
				t.Errorf("creates with batch %d = %v, want CONFIG", size, err)
			}
		}
		if _, err := orm.Creates(hookItem(e, db, nil), batch(e, labels(500)), 500); orm.ErrorCode(err) != orm.CodeBatchTooLarge {
			t.Errorf("creates of 500 rows of two columns in one batch on sqlite = %v, want BATCH_TOO_LARGE", err)
		}
		if len(*seen) != 0 {
			t.Errorf("refused creates ran %d statements, want none", len(*seen))
		}
	})
	t.Run("order", func(t *testing.T) {
		db, e, _ := hookFixture(t, "sqlite://"+filepath.Join(t.TempDir(), "parts.sqlite"))
		seen := inserts(t, db)
		given := labels(13)
		slices.Reverse(given)
		if n, err := orm.Creates(hookItem(e, db, nil), batch(e, given), 6); err != nil || n != 13 {
			t.Fatalf("creates = %d, %v; want 13 rows", n, err)
		}
		var sizes []int
		var bound []any
		for _, ev := range *seen {
			if !strings.HasPrefix(ev.SQL, "INSERT") {
				continue
			}
			sizes = append(sizes, len(ev.Binds)/2)
			bound = append(bound, ev.Binds...)
		}
		if !slices.Equal(sizes, []int{6, 6, 1}) {
			t.Errorf("INSERT batches %v, want [6 6 1]", sizes)
		}
		for i, label := range given {
			if bound[2*i+1] != label {
				t.Errorf("event bind %d = %v, want %s", 2*i+1, bound[2*i+1], label)
			}
		}
		rows := hookRows(t, e, db)
		slices.SortFunc(rows, func(a, b map[string]any) int { return cmpInt(a["id"], b["id"]) })
		for i, row := range rows {
			if row["label"] != given[i] {
				t.Errorf("row %d (id %v) has label %v, want %s", i, row["id"], row["label"], given[i])
			}
		}
	})
	t.Run("rollback", func(t *testing.T) {
		db, e, _ := hookFixture(t, "sqlite://"+filepath.Join(t.TempDir(), "parts.sqlite"))
		rows := batch(e, labels(8))
		last := hookItem(e, nil, map[string]any{"part": "p"})
		last.SetNull("label")
		rows = append(rows, as[*keywordRow](t, last.Self()))
		if _, err := orm.Creates(hookItem(e, db, nil), rows, 4); err == nil {
			t.Fatal("creates with a null label in its third batch succeeded")
		}
		if n := hookCount(t, e, db); n != 0 {
			t.Errorf("a failed creates left %d rows, want 0", n)
		}
	})
}

// cmpInt orders two integer key values.
func cmpInt(a, b any) int {
	return cmp.Compare(mustAs[int64](a), mustAs[int64](b))
}

// TestRequestBuilderErrorBeforeLockIsKept checks that a request whose builder already failed reports that error, and not the
// error of a later check such as the row-lock rule, with or without a request hook. The condition on an entity that is not
// joined leaves the query built with its lock, so only the builder's own error keeps the statement from the lock check.
func TestRequestBuilderErrorBeforeLockIsKept(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, e, entry := hookFixture(t, "sqlite://"+filepath.Join(t.TempDir(), "request_builder_error.sqlite"))
	for _, tc := range []struct {
		name string
		conn *orm.DB
	}{
		{"without a hook", db},
		{"with a hook", db.WithRequestHook(partFilter("a"))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := hookItem(e, tc.conn, nil)
			c.Connector("and", []any{entry.New(orm.NewCore(entry))})
			c.Lock("update")
			if _, err := orm.Gets[*keywordRow](c); err == nil || !strings.Contains(err.Error(), "is not joined in the statement") {
				t.Fatalf("got %v, want the builder error that the entity is not joined in the statement", err)
			}
		})
	}
}
