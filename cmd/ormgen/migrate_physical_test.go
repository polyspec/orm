//go:build physical

package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/polyspec/orm/engine/schema"
)

func TestPhysicalMigration(t *testing.T) {
	b, err := os.ReadFile("../../schema/bench.mmd")
	if err != nil {
		t.Fatal(err)
	}
	diagram, err := schema.Parse(string(b) + "\n  %% table_comment battle \"physical battle table\"\n  %% column_comment battle name \"physical battle name\"\n")
	if err != nil {
		t.Fatal(err)
	}
	want, err := schema.Build(diagram)
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
			if err := executeMigration(ctx, db, tc.driver, ddl); err != nil {
				t.Fatal(err)
			}
			live, err = liveManifest(db, tc.driver)
			if err != nil {
				t.Fatal(err)
			}
			if !schemaMatches(want, live, tc.driver) {
				t.Fatalf("initial schema mismatch: want=%s got=%s: %s", want.SchemaHash, live.SchemaHash, manifestMismatch(want, live))
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
			assertPhysicalMigrationLock(t, ctx, db, tc.driver)
		})
	}
}

func assertPhysicalMigrationLock(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	holder, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	if driver == "mysql" {
		var acquired int
		if err := holder.QueryRowContext(ctx, "SELECT GET_LOCK(CONCAT('polyspec.orm:', DATABASE()), 0)").Scan(&acquired); err != nil || acquired != 1 {
			t.Fatalf("acquire mysql test lock: acquired=%d err=%v", acquired, err)
		}
		defer holder.ExecContext(context.Background(), "SELECT RELEASE_LOCK(CONCAT('polyspec.orm:', DATABASE()))")
	} else {
		if _, err := holder.ExecContext(ctx, "SELECT pg_advisory_lock(hashtext(current_database()), hashtext('polyspec.orm.migration'))"); err != nil {
			t.Fatal(err)
		}
		defer holder.ExecContext(context.Background(), "SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('polyspec.orm.migration'))")
	}
	err = executeMigration(ctx, db, driver, "SELECT 1;")
	if err == nil || !strings.Contains(err.Error(), "MIGRATION_LOCK_BUSY") {
		t.Fatalf("expected lock contention error, got %v", err)
	}
}

func manifestMismatch(want, live *schema.Manifest) string {
	if len(want.Entities) != len(live.Entities) {
		return fmt.Sprintf("tables want=%d got=%d want_names=%v got_names=%v", len(want.Entities), len(live.Entities), manifestNames(want), manifestNames(live))
	}
	for name, we := range want.Entities {
		le := live.Entities[name]
		if le == nil {
			return fmt.Sprintf("missing table %s", name)
		}
		if we.Table != le.Table {
			return fmt.Sprintf("entity %s table want=%s got=%s", name, we.Table, le.Table)
		}
		if len(we.Columns) != len(le.Columns) {
			return fmt.Sprintf("table %s columns want=%d got=%d", name, len(we.Columns), len(le.Columns))
		}
		for i, wc := range we.Columns {
			lc := le.Columns[i]
			if wc.Name != lc.Name || wc.Type != lc.Type || wc.Raw != lc.Raw || wc.Nullable != lc.Nullable || !sameDefault(wc.Default, lc.Default) || wc.Auto != lc.Auto || wc.Unsigned != lc.Unsigned || wc.PK != lc.PK {
				return fmt.Sprintf("column %s.%s want={type:%s raw:%s nullable:%t default:%v auto:%t unsigned:%t pk:%t} got={type:%s raw:%s nullable:%t default:%v auto:%t unsigned:%t pk:%t}", name, wc.Name, wc.Type, wc.Raw, wc.Nullable, wc.Default, wc.Auto, wc.Unsigned, wc.PK, lc.Type, lc.Raw, lc.Nullable, lc.Default, lc.Auto, lc.Unsigned, lc.PK)
			}
		}
	}
	return "manifest fields differ"
}

func manifestNames(m *schema.Manifest) []string {
	names := make([]string, 0, len(m.Entities))
	for name := range m.Entities {
		names = append(names, name)
	}
	return names
}

func sameDefault(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
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
