//go:build physical

package main

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/polyspec/orm/engine/schema"
)

func TestPhysicalMigration(t *testing.T) {
	b, err := os.ReadFile("../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	want, err := schema.Load(b)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		driver, driverName, env string
	}{
		{"mysql", "mysql", "ORM_MIGRATION_MYSQL_DSN"},
		{"postgres", "pgx", "ORM_MIGRATION_POSTGRES_DSN"},
	}
	for _, tc := range cases {
		t.Run(tc.driver, func(t *testing.T) {
			dsn := os.Getenv(tc.env)
			if dsn == "" {
				t.Fatalf("%s is required; physical DB tests never skip", tc.env)
			}
			db, err := sql.Open(tc.driverName, dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			ctx := context.Background()
			if err := db.PingContext(ctx); err != nil {
				t.Fatal(err)
			}
			resetPhysicalSchema(t, db, tc.driver, want)
			if err := ensureMigrationTable(ctx, db, tc.driver); err != nil {
				t.Fatal(err)
			}
			live, err := liveManifest(db, tc.driver)
			if err != nil {
				t.Fatal(err)
			}
			ddl, err := renderCreateDDL(want, tc.driver)
			if err != nil {
				t.Fatal(err)
			}
			if err := executeMigration(ctx, db, ddl); err != nil {
				t.Fatal(err)
			}
			live, err = liveManifest(db, tc.driver)
			if err != nil {
				t.Fatal(err)
			}
			if !schemaMatches(want, live, tc.driver) {
				t.Fatalf("initial schema mismatch: want=%s got=%s", want.SchemaHash, live.SchemaHash)
			}
			if err := insertMigration(ctx, db, tc.driver, migrationRecord{MigrationID: "physical-initial", Name: "physical initial", FromHash: live.SchemaHash, ToHash: want.SchemaHash, Checksum: checksumText(ddl), Status: "applied", Operations: countSQLStatements(ddl)}); err != nil {
				t.Fatal(err)
			}
			rec, ok, err := appliedMigration(ctx, db, tc.driver, "physical-initial")
			if err != nil || !ok || rec.Status != "applied" {
				t.Fatalf("history=%#v present=%v err=%v", rec, ok, err)
			}
			live, err = liveManifest(db, tc.driver)
			if err != nil {
				t.Fatal(err)
			}
			if !schemaMatches(want, live, tc.driver) {
				t.Fatal("repeat application would not be a no-op")
			}
		})
	}
}

func resetPhysicalSchema(t *testing.T, db *sql.DB, driver string, m *schema.Manifest) {
	t.Helper()
	q := func(s string) string {
		if driver == "mysql" {
			return "`" + s + "`"
		}
		return `"` + s + `"`
	}
	for i := len(m.Order) - 1; i >= 0; i-- {
		if _, err := db.Exec("DROP TABLE IF EXISTS " + q(m.Entities[m.Order[i]].Table)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("DROP TABLE IF EXISTS orm_schema_migrations"); err != nil {
		t.Fatal(err)
	}
}
