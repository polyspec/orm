package ormgen

import (
	"context"
	"database/sql"
	"os"
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

func TestPointGeneratedTypes(t *testing.T) {
	m := pointManifest()
	dir := t.TempDir()
	if err := genGo(m, filepath.Join(dir, "model"), nil); err != nil {
		t.Fatal(err)
	}
	checks := map[string][]string{
		filepath.Join(dir, "model", "thing.go"): {"fLocation *orm.Point", "SetLocation(v *orm.Point)"},
	}
	for path, wants := range checks {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range wants {
			if !strings.Contains(string(body), want) {
				t.Errorf("%s does not contain %q", path, want)
			}
		}
	}
}
