package orm_test

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"
	"github.com/polyspec/orm/engine/runtimemodel"
)

// TestSQLiteFileNameIsThePath는 query가 붙은 SQLite DSN이 path만으로 file을
// 만드는지 확인한다. query를 file 이름에 둔 opener는 `named.sqlite?_pragma=…`
// 같은 file을 만든다(docs/dialects.md "Probe environment").
func TestSQLiteFileNameIsThePath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "named.sqlite")
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "schema", "bench.dbs"))
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
