package ormgen

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseToolDSN(t *testing.T) {
	for _, tc := range []struct {
		raw, dialect, driver, native, redacted string
	}{
		{"mysql://app:secret@db:3306/app?timezone=%2B09:00", "mysql", "mysql", "app:secret@tcp(db:3306)/app?time_zone=%27%2B09%3A00%27", "mysql://app:xxxxx@db:3306/app?timezone=%2B09:00"},
		{"mysql://root@localhost/app?socket=/tmp/mysql.sock", "mysql", "mysql", "root@unix(/tmp/mysql.sock)/app", "mysql://root@localhost/app?socket=/tmp/mysql.sock"},
		{"postgres:///app?host=/tmp&timezone=Asia/Seoul", "postgres", "pgx", "postgres:///app?host=%2Ftmp", "postgres:///app?host=/tmp&timezone=Asia/Seoul"},
		{"sqlite:///var/lib/app.sqlite", "sqlite", "sqlite", "/var/lib/app.sqlite", "sqlite:///var/lib/app.sqlite"},
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
		"root@unix(/tmp/mysql.sock)/app",
		"/var/lib/app.sqlite",
		"sqlite://relative.sqlite",
		"mysql://localhost",
		"postgres://localhost",
		"oracle://localhost/app",
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
