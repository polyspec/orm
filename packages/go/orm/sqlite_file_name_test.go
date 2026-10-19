package orm_test

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestSQLiteFileNameIsThePath checks that a SQLite DSN with a query creates the file from the
// path alone. An opener that puts the query in the file name makes a file such as `named.sqlite?_pragma=…`
// (docs/spec/dialects.md "Probe environment").
func TestSQLiteFileNameIsThePath(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dir := t.TempDir()
	path := filepath.Join(dir, "named.sqlite")
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "contracts", "fixtures", "bench", "bench.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	s := &orm.Schema{Hash: m.ManifestHash, Text: m.ManifestText}
	db, err := orm.ConnectSchema("sqlite://"+path+"?_pragma=busy_timeout(5000)&timezone=%2B00:00", s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Utils().Schema().Install(s); err != nil {
		t.Fatal(errors.Join(err, db.Close()))
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	allowed := []string{"named.sqlite", "named.sqlite-journal", "named.sqlite-shm", "named.sqlite-wal"}
	if !slices.Contains(names, "named.sqlite") {
		t.Fatalf("files %q: named.sqlite is missing", names)
	}
	for _, name := range names {
		if !slices.Contains(allowed, name) {
			t.Fatalf("files %q: %q is not named by the path", names, name)
		}
	}
}
