package ormgen

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

const featureSchema = "er" + "Diagram\n" +
	"  feature_item {\n" +
	"    bigint       seq     PK \"auto\"\n" +
	"    uuid         ref        \"?\"\n" +
	"    text         note       \"='hello'\"\n" +
	"    jsontext     meta       \"='{}'\"\n" +
	"    varchar(10)  code       \"='x'\"\n" +
	"  }\n" +
	"  feature_frozen {\n" +
	"    bigint       seq     PK \"auto\"\n" +
	"    varchar(10)  label\n" +
	"  }\n" +
	"  feature_scoped {\n" +
	"    bigint       seq     PK \"auto\"\n" +
	"  }\n" +
	"  %% orm:table entity=feature_scoped name=feature_space.feature_scoped\n" +
	"  %% orm:immutable entity=feature_frozen\n"

var featureTables = []string{"feature_item", "feature_frozen"}

func TestSQLiteSchemaFeatures(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "features.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	assertSchemaFeatures(t, context.Background(), db, "sqlite")
}

// assertSchemaFeatures installs literal defaults, a uuid column, a table in
// another schema, and an immutable table, then checks their behavior and that
// the live schema has no differences.
func assertSchemaFeatures(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	drop := func() {
		statements := []string{"DROP TABLE IF EXISTS feature_item", "DROP TABLE IF EXISTS feature_frozen"}
		switch driver {
		case "mysql":
			statements = append(statements, "DROP DATABASE IF EXISTS feature_space")
		case "postgres":
			statements = append(statements, "DROP SCHEMA IF EXISTS feature_space CASCADE", "DROP FUNCTION IF EXISTS feature_frozen_immutable_reject()")
		default:
			statements = append(statements, `DROP TABLE IF EXISTS "feature_space__feature_scoped"`)
		}
		for _, statement := range statements {
			if _, err := db.ExecContext(ctx, statement); err != nil {
				t.Fatal(err)
			}
		}
	}
	drop()
	defer drop()
	want := buildLiveDiffManifest(t, featureSchema)
	create, err := renderCreateDDL(want, driver)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, create); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO feature_item (ref) VALUES ('0b0e1c8e-6c3a-4d6f-9d55-3a8a4f0f6a11')"); err != nil {
		t.Fatal(err)
	}
	var ref, note, meta, code string
	if err := db.QueryRowContext(ctx, "SELECT ref, note, meta, code FROM feature_item").Scan(&ref, &note, &meta, &code); err != nil {
		t.Fatal(err)
	}
	if ref != "0b0e1c8e-6c3a-4d6f-9d55-3a8a4f0f6a11" || note != "hello" || strings.ReplaceAll(meta, " ", "") != "{}" || code != "x" {
		t.Fatalf("defaults: ref=%q note=%q meta=%q code=%q", ref, note, meta, code)
	}
	// jsontext keeps the stored text: member order, duplicate keys as
	// written, and an empty object apart from an empty array.
	ordered := `{"b": 1, "a": [2, 1], "a": 3, "c": {"z": true, "y": null}, "d": {}, "e": []}`
	update := "UPDATE feature_item SET meta = ?"
	if driver == "postgres" {
		update = "UPDATE feature_item SET meta = $1"
	}
	if _, err := db.ExecContext(ctx, update, ordered); err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := db.QueryRowContext(ctx, "SELECT meta FROM feature_item").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != ordered {
		t.Fatalf("%s json text = %q, want %q", driver, stored, ordered)
	}
	scoped := "feature_space.feature_scoped"
	if driver == "sqlite" {
		scoped = `"feature_space__feature_scoped"`
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO "+scoped+" (seq) VALUES (1)"); err != nil {
		t.Fatalf("qualified table: %v", err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO feature_frozen (label) VALUES ('a')"); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{"UPDATE feature_frozen SET label = 'b'", "DELETE FROM feature_frozen"} {
		if _, err := db.ExecContext(ctx, statement); err == nil || !strings.Contains(err.Error(), "immutable table: feature_frozen") {
			t.Fatalf("%s: %v", statement, err)
		}
	}
	all, err := liveManifest(db, driver)
	if err != nil {
		t.Fatal(err)
	}
	live := &schema.Manifest{SchemaHash: all.SchemaHash, Entities: map[string]*schema.Entity{}}
	for _, name := range all.Order {
		if slices.Contains(featureTables, name) {
			live.Order = append(live.Order, name)
			live.Entities[name] = all.Entities[name]
		}
	}
	for _, name := range all.Immutable {
		if slices.Contains(featureTables, name) {
			live.Immutable = append(live.Immutable, name)
		}
	}
	local := &schema.Manifest{SchemaHash: want.SchemaHash, Order: featureTables, Entities: map[string]*schema.Entity{}, Immutable: want.Immutable}
	for _, name := range featureTables {
		local.Entities[name] = want.Entities[name]
	}
	again, err := renderDiff(live, local, driver, false)
	if err != nil || !strings.Contains(again, "-- no changes") {
		t.Fatalf("%s live diff = %v\n%s", driver, err, again)
	}
}
