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
			assertPhysicalAESVersionUpgrade(t, ctx, db, tc.driver)
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
			assertRenamePreservesData(t, ctx, db, tc.driver)
			assertPhysicalConstraintDiff(t, ctx, db, tc.driver)
			assertPhysicalCompositeKeys(t, ctx, db, tc.driver)
			assertPhysicalStructuredPlan(t, ctx, db, tc.driver, want)
			assertPhysicalRollback(t, ctx, db, tc.driver)
			assertPhysicalPoint(t, ctx, db, tc.driver)
			assertPhysicalScope(t, ctx, db, tc.driver)
			assertPhysicalCheckImport(t, ctx, db, tc.driver)
		})
	}
}

func assertPhysicalCheckImport(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	q := func(name string) string {
		if driver == "mysql" {
			return "`" + name + "`"
		}
		return `"` + name + `"`
	}
	table := "check_import_probe"
	_, _ = db.ExecContext(ctx, "DROP TABLE IF EXISTS "+q(table))
	t.Cleanup(func() { _, _ = db.ExecContext(context.Background(), "DROP TABLE IF EXISTS "+q(table)) })
	create := "CREATE TABLE " + q(table) + " (" + q("id") + " BIGINT NOT NULL PRIMARY KEY, " + q("quantity") + " INTEGER NOT NULL, CONSTRAINT " + q("positive_quantity") + " CHECK (" + q("quantity") + " >= 0))"
	if _, err := db.ExecContext(ctx, create); err != nil {
		t.Fatal(err)
	}
	tables, err := readTables(db, driver, map[string]bool{table: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) != 1 || len(tables[0].Checks) != 1 || tables[0].Checks[0].Name != "positive_quantity" || !strings.Contains(tables[0].Checks[0].Expr, "quantity") {
		t.Fatalf("%s check import=%#v", driver, tables)
	}
}

func assertPhysicalCompositeKeys(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	q := func(name string) string {
		if driver == "mysql" {
			return "`" + name + "`"
		}
		return `"` + name + `"`
	}
	_, _ = db.ExecContext(ctx, "DROP TABLE IF EXISTS "+q("composite_membership"))
	_, _ = db.ExecContext(ctx, "DROP TABLE IF EXISTS "+q("composite_account"))
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DROP TABLE IF EXISTS "+q("composite_membership"))
		_, _ = db.ExecContext(context.Background(), "DROP TABLE IF EXISTS "+q("composite_account"))
	})
	want := buildPhysicalManifest(t, `erDiagram
  composite_account {
    bigint tenant_id PK
    bigint id PK
    varchar(191) name
  }
  composite_membership {
    bigint tenant_id PK,FK
    bigint account_id PK,FK
    varchar(191) role
  }
  composite_account ||--o{ composite_membership : "(tenant_id, account_id) (account / memberships) cascade"
`)
	ddl, err := renderCreateDDL(want, driver)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, ddl); err != nil {
		t.Fatalf("create composite schema: %v\n%s", err, ddl)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO "+q("composite_account")+" ("+q("tenant_id")+", "+q("id")+", "+q("name")+") VALUES (7, 11, 'account')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO "+q("composite_membership")+" ("+q("tenant_id")+", "+q("account_id")+", "+q("role")+") VALUES (7, 11, 'owner')"); err != nil {
		t.Fatal(err)
	}
	live, err := liveManifest(db, driver)
	if err != nil {
		t.Fatal(err)
	}
	entity := live.Entities["composite_membership"]
	if entity == nil || !containsColumns([][]string{entity.PK}, []string{"tenant_id", "account_id"}) {
		t.Fatalf("%s composite primary key differs: %#v", driver, entity)
	}
	var relation *schema.Rel
	for _, candidate := range entity.Relations {
		if candidate.Target == "composite_account" {
			relation = candidate
			break
		}
	}
	if relation == nil || relation.OnDelete != "cascade" || len(relation.Keys) != 2 || relation.Keys[0].Local != "tenant_id" || relation.Keys[0].Target != "tenant_id" || relation.Keys[1].Local != "account_id" || relation.Keys[1].Target != "id" {
		t.Fatalf("%s composite foreign key differs: %#v", driver, relation)
	}
	var count int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+q("composite_membership")+" WHERE "+q("tenant_id")+"=7 AND "+q("account_id")+"=11").Scan(&count); err != nil || count != 1 {
		t.Fatalf("%s composite data differs: count=%d err=%v", driver, count, err)
	}
}

func assertPhysicalConstraintDiff(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	q := func(s string) string {
		if driver == "mysql" {
			return "`" + s + "`"
		}
		return `"` + s + `"`
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS "+q("migration_item")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS "+q("migration_owner")); err != nil {
		t.Fatal(err)
	}
	base := buildPhysicalManifest(t, `erDiagram
  migration_owner {
    bigint id PK
  }
  migration_item {
    bigint id PK
    bigint owner_id FK
    varchar(20) code "?"
    text body "?"
  }
  migration_owner ||--o{ migration_item : owner_id
  %% index migration_item (owner_id) old_owner_idx
  %% unique migration_item (code)
  %% fulltext migration_item (body)
`)
	target := buildPhysicalManifest(t, `erDiagram
  migration_owner {
    bigint id PK
  }
  migration_item {
    bigint id PK
    bigint owner_id FK
    varchar(40) code "='active'"
    text body "?"
  }
  migration_owner ||--o{ migration_item : owner_id cascade
  %% index migration_item (code) new_code_idx
  %% unique migration_item (owner_id, code)
  %% fulltext migration_item (code, body)
`)
	create, err := renderCreateDDL(base, driver)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, create); err != nil {
		t.Fatal(err)
	}
	forward, err := renderDiff(base, target, driver, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, forward); err != nil {
		t.Fatalf("apply constraint diff: %v\n%s", err, forward)
	}
	assertPhysicalConstraintState(t, ctx, db, driver, true)
	live, err := liveManifest(db, driver)
	if err != nil {
		t.Fatal(err)
	}
	item := live.Entities["migration_item"]
	if item == nil || len(item.Indexes["new_code_idx"]) != 1 || item.Indexes["new_code_idx"][0] != "code" || !containsColumns(item.Unique, []string{"owner_id", "code"}) || !containsColumns(item.Fulltext, []string{"code", "body"}) {
		t.Fatalf("%s imported indexes differ: %#v", driver, item)
	}
	if relation := item.Relations["owner"]; relation == nil || relation.OnDelete != "cascade" {
		t.Fatalf("%s imported foreign key differs: %#v", driver, relation)
	}

	rollback, err := renderDiff(target, base, driver, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, rollback); err != nil {
		t.Fatalf("rollback constraint diff: %v\n%s", err, rollback)
	}
	assertPhysicalConstraintState(t, ctx, db, driver, false)
	if _, err := db.ExecContext(ctx, "DROP TABLE "+q("migration_item")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE "+q("migration_owner")); err != nil {
		t.Fatal(err)
	}
}

func containsColumns(groups [][]string, want []string) bool {
	for _, group := range groups {
		if len(group) != len(want) {
			continue
		}
		match := true
		for i := range want {
			if group[i] != want[i] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func assertPhysicalConstraintState(t *testing.T, ctx context.Context, db *sql.DB, driver string, target bool) {
	t.Helper()
	indexNames := []string{"old_owner_idx", "uq_migration_item_code", "ft_body"}
	deleteRule := "RESTRICT"
	columnLimit := int64(20)
	nullable := "YES"
	defaultValue := ""
	if target {
		indexNames = []string{"new_code_idx", "uq_migration_item_owner_id_code", "ft_code_body"}
		deleteRule = "CASCADE"
		columnLimit = 40
		nullable = "NO"
		defaultValue = "active"
	}
	for _, name := range indexNames {
		var count int
		if driver == "mysql" {
			if err := db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='migration_item' AND INDEX_NAME=?`, name).Scan(&count); err != nil {
				t.Fatal(err)
			}
		} else {
			physicalName := name
			if strings.HasPrefix(name, "ft_") || strings.HasSuffix(name, "_idx") {
				physicalName = "migration_item_" + name
			}
			if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pg_indexes WHERE schemaname=current_schema() AND tablename='migration_item' AND indexname=$1`, physicalName).Scan(&count); err != nil {
				t.Fatal(err)
			}
		}
		if count != 1 {
			t.Fatalf("%s index %s count=%d", driver, name, count)
		}
	}
	var gotRule string
	if driver == "mysql" {
		if err := db.QueryRowContext(ctx, `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='migration_item' AND CONSTRAINT_NAME='fk_migration_item_owner_id'`).Scan(&gotRule); err != nil {
			t.Fatal(err)
		}
	} else {
		if err := db.QueryRowContext(ctx, `SELECT CASE confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' ELSE 'RESTRICT' END FROM pg_constraint WHERE conrelid='migration_item'::regclass AND conname='fk_migration_item_owner_id'`).Scan(&gotRule); err != nil {
			t.Fatal(err)
		}
	}
	if gotRule != deleteRule {
		t.Fatalf("%s delete rule=%s want=%s", driver, gotRule, deleteRule)
	}
	var gotLimit sql.NullInt64
	var gotNullable string
	var gotDefault sql.NullString
	query := `SELECT CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='migration_item' AND COLUMN_NAME='code'`
	if driver == "postgres" {
		query = `SELECT character_maximum_length, is_nullable, column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='migration_item' AND column_name='code'`
	}
	if err := db.QueryRowContext(ctx, query).Scan(&gotLimit, &gotNullable, &gotDefault); err != nil {
		t.Fatal(err)
	}
	if !gotLimit.Valid || gotLimit.Int64 != columnLimit || gotNullable != nullable {
		t.Fatalf("%s code metadata limit=%v nullable=%s", driver, gotLimit, gotNullable)
	}
	gotDefaultValue := ""
	if gotDefault.Valid {
		gotDefaultValue = strings.Trim(strings.Split(gotDefault.String, "::")[0], "'")
	}
	if gotDefaultValue != defaultValue {
		t.Fatalf("%s code default=%q want=%q", driver, gotDefaultValue, defaultValue)
	}
}

func assertPhysicalAESVersionUpgrade(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	quote := func(value string) string { return `"` + value + `"` }
	if driver == "mysql" {
		quote = func(value string) string { return "`" + value + "`" }
	}
	table := quote("aes_upgrade_probe")
	if _, err := db.ExecContext(ctx, "CREATE TABLE "+table+" ("+quote("seq")+" bigint NOT NULL PRIMARY KEY, "+quote("aes_hex_email")+" varchar(255) NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	target := buildPhysicalManifest(t, "erDiagram\n  aes_upgrade_probe {\n    bigint seq PK\n    varchar(255) aes_hex_email\n    int aes_key_version \"=1\"\n  }\n")
	live, err := liveManifest(db, driver)
	if err != nil {
		t.Fatalf("read AES schema without version column: %v", err)
	}
	plan, err := renderDiff(live, target, driver, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan, "aes_key_version") {
		t.Fatalf("AES version plan does not add the version column: %s", plan)
	}
	if err := executeMigration(ctx, db, driver, plan); err != nil {
		t.Fatal(err)
	}
	upgraded, err := liveManifest(db, driver)
	if err != nil {
		t.Fatal(err)
	}
	if !schemaMatches(target, upgraded, driver) {
		t.Fatalf("AES version upgrade mismatch: %s", manifestMismatch(target, upgraded))
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE "+table); err != nil {
		t.Fatal(err)
	}
}

func assertPhysicalRollback(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	q := func(s string) string {
		if driver == "mysql" {
			return "`" + s + "`"
		}
		return `"` + s + `"`
	}
	for _, table := range []string{"rollback_probe", "migration_failure_probe", "migration_probe"} {
		if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS "+q(table)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS orm_schema_migrations"); err != nil {
		t.Fatal(err)
	}
	base := buildPhysicalManifest(t, "erDiagram\n  rollback_probe {\n    bigint seq PK\n    varchar(32) name\n  }\n")
	target := buildPhysicalManifest(t, "erDiagram\n  rollback_probe {\n    bigint seq PK\n    varchar(32) name\n    text note \"?\"\n  }\n")
	create, err := renderCreateDDL(base, driver)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, create); err != nil {
		t.Fatal(err)
	}
	diff, err := renderDiff(base, target, driver, true)
	if err != nil {
		t.Fatal(err)
	}
	plan := testMigrationPlan(base, target, driver, diff)
	plan.MigrationID = "20260912-physical-rollback-" + driver
	plan.Name = "physical rollback"
	if err := executeMigration(ctx, db, driver, planSQL(plan.Operations)); err != nil {
		t.Fatal(err)
	}
	if err := ensureMigrationTable(ctx, db, driver); err != nil {
		t.Fatal(err)
	}
	record := migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.FromHash, ToHash: plan.ToHash, Checksum: plan.Checksum, Status: "applied", Operations: len(plan.Operations)}
	if err := insertMigration(ctx, db, driver, record); err != nil {
		t.Fatal(err)
	}
	logDir := t.TempDir()
	status, err := rollbackMigration(ctx, db, plan, logDir)
	if err != nil || status != "rolled_back" {
		t.Fatalf("physical rollback status=%s err=%v", status, err)
	}
	live, err := liveManifest(db, driver)
	if err != nil || !schemaMatches(base, live, driver) {
		t.Fatalf("physical rollback schema mismatch: %s err=%v", manifestMismatch(base, live), err)
	}
	status, err = rollbackMigration(ctx, db, plan, logDir)
	if err != nil || status != "noop" {
		t.Fatalf("physical rollback repeat status=%s err=%v", status, err)
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS "+q("rollback_probe")); err != nil {
		t.Fatal(err)
	}
}

func assertPhysicalPoint(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	q := func(s string) string {
		if driver == "mysql" {
			return "`" + s + "`"
		}
		return `"` + s + `"`
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS "+q("point_probe")); err != nil {
		t.Fatal(err)
	}
	m := buildPhysicalManifest(t, "erDiagram\n  point_probe {\n    bigint id PK\n    point location\n  }\n")
	ddl, err := renderCreateDDL(m, driver)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, ddl); err != nil {
		t.Fatal(err)
	}
	insert, read := "", ""
	if driver == "mysql" {
		insert = "INSERT INTO `point_probe` (`id`, `location`) VALUES (?, ST_PointFromText(?))"
		read = "SELECT ST_AsText(`location`) FROM `point_probe` WHERE `id` = ?"
	} else {
		insert = `INSERT INTO "point_probe" ("id", "location") VALUES ($1, CAST($2 AS text)::point)`
		read = `SELECT ("location")::text FROM "point_probe" WHERE "id" = $1`
	}
	value := "POINT(1.25 -2)"
	if driver == "postgres" {
		value = "(1.25,-2)"
	}
	if _, err := db.ExecContext(ctx, insert, 1, value); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := db.QueryRowContext(ctx, read, 1).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != "POINT(1.25 -2)" && got != "(1.25,-2)" {
		t.Fatalf("%s point result=%q", driver, got)
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE "+q("point_probe")); err != nil {
		t.Fatal(err)
	}
}

func assertPhysicalStructuredPlan(t *testing.T, ctx context.Context, db *sql.DB, driver string, existing *schema.Manifest) {
	t.Helper()
	resetPhysicalSchema(t, db, driver, existing)
	if err := ensureMigrationTable(ctx, db, driver); err != nil {
		t.Fatal(err)
	}
	q := func(s string) string {
		if driver == "mysql" {
			return "`" + s + "`"
		}
		return `"` + s + `"`
	}
	for _, name := range []string{"migration_probe", "migration_failure_probe"} {
		if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS "+q(name)); err != nil {
			t.Fatal(err)
		}
	}
	base := buildPhysicalManifest(t, "erDiagram\n  migration_probe {\n    bigint seq PK\n    varchar(32) name\n  }\n")
	target := buildPhysicalManifest(t, "erDiagram\n  migration_probe {\n    bigint seq PK\n    varchar(32) name\n    text note \"?\"\n  }\n")
	create, err := renderCreateDDL(base, driver)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, create); err != nil {
		t.Fatal(err)
	}
	diff, err := renderDiff(base, target, driver, false)
	if err != nil {
		t.Fatal(err)
	}
	operations := splitSQL(diff)
	plan := migrationPlanFile{Version: 1, MigrationID: "physical-plan", Name: "physical plan", Driver: driver, FromHash: base.SchemaHash, FromSchema: base, ToHash: target.SchemaHash}
	for _, statement := range operations {
		plan.Operations = append(plan.Operations, planOperation{SQL: statement + ";"})
	}
	plan.Checksum = checksumText(planSQL(plan.Operations))
	record := migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.FromHash, ToHash: plan.ToHash, Checksum: plan.Checksum, Status: "failed", Operations: len(plan.Operations)}
	if err := insertMigration(ctx, db, driver, record); err != nil {
		t.Fatal(err)
	}
	logDir := t.TempDir()
	status, err := recoverMigration(ctx, db, driver, plan, target, logDir)
	if err != nil || status != "retryable" {
		t.Fatalf("source recovery status=%s err=%v", status, err)
	}
	status, err = recoverMigration(ctx, db, driver, plan, target, logDir)
	if err != nil || status != "noop" {
		t.Fatalf("source recovery repeat status=%s err=%v", status, err)
	}
	if err := executeClaimedMigration(ctx, db, driver, plan.MigrationID, "retryable", planSQL(plan.Operations)); err != nil {
		t.Fatal(err)
	}
	status, err = recoverMigration(ctx, db, driver, plan, target, logDir)
	if err != nil || status != "applied" {
		t.Fatalf("target recovery status=%s err=%v", status, err)
	}
	status, err = recoverMigration(ctx, db, driver, plan, target, logDir)
	if err != nil || status != "noop" {
		t.Fatalf("target recovery repeat status=%s err=%v", status, err)
	}
	live, err := liveManifest(db, driver)
	if err != nil {
		t.Fatal(err)
	}
	if live.Entities["migration_probe"] == nil || len(live.Entities["migration_probe"].Columns) != 3 {
		t.Fatalf("structured plan target not applied: %#v", live.Entities["migration_probe"])
	}
	repeat, found, err := appliedMigration(ctx, db, driver, plan.MigrationID)
	if err != nil || !found || repeat.Checksum != plan.Checksum {
		t.Fatalf("structured plan repeat: record=%#v found=%v err=%v", repeat, found, err)
	}
	if _, err := db.ExecContext(ctx, "ALTER TABLE "+q("migration_probe")+" ADD COLUMN "+q("external_drift")+" varchar(8)"); err != nil {
		t.Fatal(err)
	}
	live, err = liveManifest(db, driver)
	if err != nil {
		t.Fatal(err)
	}
	if schemaMatches(target, live, driver) {
		t.Fatal("structured plan drift was not detected")
	}
	failureSQL := "CREATE TABLE " + q("migration_failure_probe") + " (id integer); CREATE TABLE " + q("migration_failure_probe") + " (id integer);"
	if err := executeMigration(ctx, db, driver, failureSQL); err == nil || !strings.Contains(err.Error(), "operation=2") {
		t.Fatalf("structured plan failure detail = %v", err)
	}
}

func buildPhysicalManifest(t *testing.T, src string) *schema.Manifest {
	t.Helper()
	d, err := schema.Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	return m
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
		if err := holder.QueryRowContext(ctx, "SELECT GET_LOCK(CONCAT('orm:', LEFT(SHA2(DATABASE(), 256), 60)), 0)").Scan(&acquired); err != nil || acquired != 1 {
			t.Fatalf("acquire mysql test lock: acquired=%d err=%v", acquired, err)
		}
		defer holder.ExecContext(context.Background(), "SELECT RELEASE_LOCK(CONCAT('orm:', LEFT(SHA2(DATABASE(), 256), 60)))")
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
	order, err := ddlEntityOrder(m)
	if err != nil {
		t.Fatal(err)
	}
	for i := len(order) - 1; i >= 0; i-- {
		if _, err := db.Exec("DROP TABLE IF EXISTS " + q(m.Entities[order[i]].Table)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("DROP TABLE IF EXISTS orm_schema_migrations"); err != nil {
		t.Fatal(err)
	}
}
