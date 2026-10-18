package orm_test

import (
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// openRevision installs a table with a revision column in a new SQLite file and
// creates one row at revision 3 (docs/dsl.md "Writes", expectRevision).
func openRevision(t *testing.T) (*orm.DB, func() *orm.Core, int64) {
	t.Helper()
	s := documentSchema(t, "dbspec 1 revision\n\ntable note {\n  seq i64 identity\n  label varchar(32)\n  revision i64\n  primary key (seq)\n}\n")
	db, err := orm.ConnectSchema("sqlite://"+filepath.Join(t.TempDir(), "revision.sqlite"), s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Utils().Schema().Install(s); err != nil {
		t.Fatal(err)
	}
	ent := rowEntity("note", s, "seq", "label", "revision")
	model := func() *orm.Core {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		return c
	}
	c := model()
	c.Set("label", "first")
	c.Set("revision", int64(3))
	created, err := c.Create()
	if err != nil {
		t.Fatal(err)
	}
	return db, model, created.(*keywordRow).vals["seq"].(int64)
}

// revisionRow reads the label and revision of the row, or nil when it is gone.
func revisionRow(t *testing.T, model func() *orm.Core, seq int64) map[string]any {
	t.Helper()
	q := model()
	q.AddAllColumns()
	q.Where("", []orm.ChainKey{{Column: "seq"}}, seq)
	row, err := q.Get()
	if err != nil {
		t.Fatal(err)
	}
	if row == nil {
		return nil
	}
	return row.(*keywordRow).vals
}

func TestRevisionUpdateMatchBumpsTheRevision(t *testing.T) {
	testcase.Start(t, testcase.Database)
	_, model, seq := openRevision(t)
	c := model()
	c.Set("seq", seq)
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
	testcase.Start(t, testcase.Database)
	_, model, seq := openRevision(t)
	c := model()
	c.Set("seq", seq)
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
	testcase.Start(t, testcase.Database)
	_, model, seq := openRevision(t)
	c := model()
	c.Set("seq", seq)
	c.ExpectRevision("revision", 3)
	if err := c.Delete(nil); err != nil {
		t.Fatal(err)
	}
	if got := revisionRow(t, model, seq); got != nil {
		t.Fatalf("row = %v, want deleted", got)
	}
}

func TestRevisionDeleteMismatchChangesNothing(t *testing.T) {
	testcase.Start(t, testcase.Database)
	_, model, seq := openRevision(t)
	c := model()
	c.Set("seq", seq)
	c.ExpectRevision("revision", 4)
	if err := c.Delete(nil); orm.ErrorCode(err) != orm.CodeRevisionChanged {
		t.Fatalf("delete err = %v, want %s", err, orm.CodeRevisionChanged)
	}
	if got := revisionRow(t, model, seq); got == nil || got["revision"] != int64(3) {
		t.Fatalf("row = %v, want it kept at revision 3", got)
	}
}
