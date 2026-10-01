package ormgen

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
	_ "modernc.org/sqlite"
)

func pointManifest() *schema.Manifest {
	d, err := schema.Parse("erDiagram\n  thing {\n    bigint id PK\n    point location \"?\"\n  }\n")
	if err != nil {
		panic(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		panic(err)
	}
	return m
}

func TestPointSQLitePhysicalRoundTrip(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "point.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ddl, err := renderCreateDDL(pointManifest(), "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(context.Background(), db, "sqlite", ddl); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO "thing" ("id", "location") VALUES (?, ?)`, 1, "POINT(1.25 -2)"); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := db.QueryRow(`SELECT "location" FROM "thing" WHERE "id" = ?`, 1).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != "POINT(1.25 -2)" {
		t.Fatalf("point result=%q", got)
	}
}

func TestPointDDL(t *testing.T) {
	m := pointManifest()
	for driver, want := range map[string]string{"mysql": "`location` point", "postgres": `"location" point`, "sqlite": `"location" TEXT`} {
		ddl, err := renderDDL(m, driver)
		if err != nil || !strings.Contains(ddl, want) {
			t.Fatalf("%s DDL=%q err=%v", driver, ddl, err)
		}
	}
}
