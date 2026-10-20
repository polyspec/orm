package orm_test

import (
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// openRevision installs a table with a revision column in a new SQLite file and
// creates one row at revision 3 (docs/spec/dsl.md "Writes", expectRevision).
func openRevision(t *testing.T) (*orm.DB, func() *orm.Core, int64) {
	t.Helper()
	s := documentSchema(t, "dbspec 1 revision\n\ntable note {\n  seq i64 identity\n  label varchar(32)\n  revision i64\n  primary key (seq)\n}\n")
	db := openSchemaDB(t, "sqlite://"+filepath.Join(t.TempDir(), "revision.sqlite"), s)
	ent := rowEntity("note", s, "seq", "label", "revision")
	model := coreFunc(db, ent)
	c := model()
	c.Set("label", "first")
	c.Set("revision", int64(3))
	created, err := c.Create()
	if err != nil {
		t.Fatal(err)
	}
	return db, model, as[int64](t, as[*keywordRow](t, created).vals["seq"])
}

// revisionCore is a core of model that holds the row of seq.
func revisionCore(model func() *orm.Core, seq int64) *orm.Core {
	c := model()
	c.Set("seq", seq)
	return c
}

// revisionRow reads the label and revision of the row, or nil when it is gone.
func revisionRow(t *testing.T, model func() *orm.Core, seq int64) map[string]any {
	t.Helper()
	row := getBySeq(t, model, seq)
	if row == nil {
		return nil
	}
	return as[*keywordRow](t, row).vals
}

func TestRevisionUpdateMatchBumpsTheRevision(t *testing.T) {
	// The test of DSL-108, DSL-114 (docs/spec).
	testcase.Start(t, testcase.Database)
	_, model, seq := openRevision(t)
	c := revisionCore(model, seq)
	c.Set("label", "second")
	c.ExpectRevision("revision", 3)
	if err := c.Update(nil); err != nil {
		t.Fatal(err)
	}
	if got := revisionRow(t, model, seq); got["label"] != "second" || got["revision"] != int64(4) {
		t.Fatalf("row = %v, want label second at revision 4", got)
	}
}

func TestRevisionUpdateMismatchChangesNothing(t *testing.T) {
	// The test of DSL-108, DSL-114 (docs/spec).
	testcase.Start(t, testcase.Database)
	_, model, seq := openRevision(t)
	c := revisionCore(model, seq)
	c.Set("label", "stale")
	c.ExpectRevision("revision", 2)
	if err := c.Update(nil); orm.ErrorCode(err) != orm.CodeRevisionChanged {
		t.Fatalf("update err = %v, want %s", err, orm.CodeRevisionChanged)
	}
	if got := revisionRow(t, model, seq); got["label"] != "first" || got["revision"] != int64(3) {
		t.Fatalf("row = %v, want label first at revision 3", got)
	}
}

func TestRevisionDeleteMatchDeletes(t *testing.T) {
	// The test of DSL-108, DSL-114 (docs/spec).
	testcase.Start(t, testcase.Database)
	_, model, seq := openRevision(t)
	c := revisionCore(model, seq)
	c.ExpectRevision("revision", 3)
	if err := c.Delete(nil); err != nil {
		t.Fatal(err)
	}
	if got := revisionRow(t, model, seq); got != nil {
		t.Fatalf("row = %v, want deleted", got)
	}
}

func TestRevisionDeleteMismatchChangesNothing(t *testing.T) {
	// The test of DSL-108, DSL-114 (docs/spec).
	testcase.Start(t, testcase.Database)
	_, model, seq := openRevision(t)
	c := revisionCore(model, seq)
	c.ExpectRevision("revision", 4)
	if err := c.Delete(nil); orm.ErrorCode(err) != orm.CodeRevisionChanged {
		t.Fatalf("delete err = %v, want %s", err, orm.CodeRevisionChanged)
	}
	if got := revisionRow(t, model, seq); got == nil || got["revision"] != int64(3) {
		t.Fatalf("row = %v, want it kept at revision 3", got)
	}
}
