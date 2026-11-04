package orm_test

import (
	"cmp"
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

// requestHookCases holds what the recipe request_hook cannot state, FCV-2: request-hook-root-is-the-connection and
// request-hook-params-are-read-only. Each body receives a connection to an empty database with request_hook.dbs installed.
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
}

// Requirements: INT-78, INT-78a.
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
