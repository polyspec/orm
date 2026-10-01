package ormgen

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestParseToolDSN(t *testing.T) {
	for _, tc := range []struct {
		raw, dialect, driver, native, redacted string
	}{
		{"mysql://orm:secret@db:3306/orm_example?timezone=%2B09:00", "mysql", "mysql", "orm:secret@tcp(db:3306)/orm_example?time_zone=%27%2B09%3A00%27", "mysql://orm:xxxxx@db:3306/orm_example?timezone=%2B09:00"},
		{"mysql://root@localhost/orm_example?socket=/tmp/mysql.sock", "mysql", "mysql", "root@unix(/tmp/mysql.sock)/orm_example", "mysql://root@localhost/orm_example?socket=/tmp/mysql.sock"},
		{"postgres:///orm_example?host=/tmp&timezone=Asia/Seoul", "postgres", "pgx", "postgres:///orm_example?host=%2Ftmp", "postgres:///orm_example?host=/tmp&timezone=Asia/Seoul"},
		{"sqlite:///var/lib/orm_example.sqlite", "sqlite", "sqlite", "/var/lib/orm_example.sqlite", "sqlite:///var/lib/orm_example.sqlite"},
	} {
		got, err := parseToolDSN(tc.raw)
		if err != nil {
			t.Fatalf("%s: %v", tc.raw, err)
		}
		if got.dialect != tc.dialect || got.driver != tc.driver || got.native != tc.native || got.redacted() != tc.redacted {
			t.Fatalf("%s: got dialect=%s driver=%s native=%s redacted=%s", tc.raw, got.dialect, got.driver, got.native, got.redacted())
		}
	}
	for _, raw := range []string{
		"root@unix(/tmp/mysql.sock)/orm_example",
		"/var/lib/orm_example.sqlite",
		"sqlite://relative.sqlite",
		"mysql://localhost",
		"postgres://localhost",
		"oracle://localhost/orm_example",
	} {
		if _, err := parseToolDSN(raw); err == nil || !strings.HasPrefix(err.Error(), "MIGRATION_CONFIG:") {
			t.Fatalf("%s: err=%v", raw, err)
		}
	}
}

func TestReadTablesFiltersSQLite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "import.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, stmt := range []string{
		`CREATE TABLE "kept" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL)`,
		`CREATE TABLE "other" ("id" INTEGER PRIMARY KEY)`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	tables, err := readTables(db, "sqlite", map[string]bool{"kept": true})
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) != 1 || tables[0].Name != "kept" || tables[0].Columns[0].Extra != "auto_increment" {
		t.Fatalf("tables=%#v", tables)
	}
	opened, dsn, err := openToolDB("sqlite://" + path)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	if dsn.dialect != "sqlite" {
		t.Fatalf("dialect=%s", dsn.dialect)
	}
}

// TestToolSQLiteFileNameIsThePath는 schema tool이 query가 붙은 SQLite DSN을
// path만으로 여는지 확인한다(docs/dialects.md "Probe environment").
func TestToolSQLiteFileNameIsThePath(t *testing.T) {
	dir := t.TempDir()
	db, _, err := openToolDB("sqlite://" + filepath.Join(dir, "named.sqlite") + "?_pragma=busy_timeout(5000)&timezone=%2B00:00")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE t (a INTEGER)"); err != nil {
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
	if !slices.Contains(names, "named.sqlite") {
		t.Fatalf("files %q: named.sqlite is missing", names)
	}
	for _, name := range names {
		if !slices.Contains([]string{"named.sqlite", "named.sqlite-journal", "named.sqlite-shm", "named.sqlite-wal"}, name) {
			t.Fatalf("files %q: %q is not named by the path", names, name)
		}
	}
}
