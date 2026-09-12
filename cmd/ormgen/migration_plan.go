package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/engine/schema"
)

type migrationPlanFile struct {
	Version     int              `json:"version"`
	MigrationID string           `json:"migration_id"`
	Name        string           `json:"name"`
	Driver      string           `json:"driver"`
	FromHash    string           `json:"from_schema_hash"`
	FromSchema  *schema.Manifest `json:"from_schema"`
	ToHash      string           `json:"to_schema_hash"`
	Checksum    string           `json:"plan_checksum"`
	Operations  []planOperation  `json:"operations"`
}

type planOperation struct {
	SQL         string `json:"sql"`
	Destructive bool   `json:"destructive"`
}

func planCmd(args []string) {
	fs := flag.NewFlagSet("plan", flag.ExitOnError)
	fromPath := fs.String("from", "", "previous schema.json (required)")
	toPath := fs.String("to", "", "target schema.json (required)")
	dialect := fs.String("dialect", "mysql", "mysql|postgres|sqlite")
	out := fs.String("out", "", "output migration plan JSON (required)")
	id := fs.String("migration-id", "", "stable migration identifier")
	name := fs.String("name", "schema migration", "migration name")
	fs.Parse(args)
	if *fromPath == "" || *toPath == "" || *out == "" {
		fail(fmt.Errorf("MIGRATION_CONFIG: --from, --to and --out are required"))
	}
	from, err := loadManifestFile(*fromPath)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: from: %w", err))
	}
	to, err := loadManifestFile(*toPath)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: to: %w", err))
	}
	sqlText, err := renderDiff(from, to, *dialect, true)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_PLAN: %w", err))
	}
	operations := make([]planOperation, 0)
	for _, statement := range splitSQL(sqlText) {
		upper := strings.ToUpper(statement)
		operations = append(operations, planOperation{SQL: statement + ";", Destructive: strings.Contains(upper, "DROP TABLE") || strings.Contains(upper, "DROP COLUMN") || strings.Contains(upper, "MODIFY COLUMN") || strings.Contains(upper, "ALTER COLUMN")})
	}
	if *id == "" {
		*id = "schema-" + to.SchemaHash
	}
	plan := migrationPlanFile{Version: 1, MigrationID: *id, Name: *name, Driver: *dialect, FromHash: from.SchemaHash, FromSchema: from, ToHash: to.SchemaHash, Operations: operations}
	plan.Checksum = checksumText(planSQL(operations))
	b, err := json.MarshalIndent(plan, "", "  ")
	if err != nil {
		fail(fmt.Errorf("MIGRATION_PLAN: encode: %w", err))
	}
	if err := os.WriteFile(*out, append(b, '\n'), 0o644); err != nil {
		fail(fmt.Errorf("MIGRATION_PLAN: write %s: %w", *out, err))
	}
}

func planSQL(operations []planOperation) string {
	var b strings.Builder
	for _, operation := range operations {
		b.WriteString(operation.SQL)
		if !strings.HasSuffix(operation.SQL, "\n") {
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func verifyCmd(args []string) {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	dsn := fs.String("dsn", "", "database DSN or SQLite path (required)")
	driver := fs.String("driver", "mysql", "mysql|postgres|sqlite")
	schemaPath := fs.String("schema", "", "target schema.json (required)")
	fs.Parse(args)
	if *dsn == "" || *schemaPath == "" {
		fail(fmt.Errorf("MIGRATION_CONFIG: --dsn and --schema are required"))
	}
	if *driver != "mysql" && *driver != "postgres" && *driver != "sqlite" {
		fail(fmt.Errorf("MIGRATION_CONFIG: unsupported driver %q", *driver))
	}
	want, err := loadManifestFile(*schemaPath)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: %w", err))
	}
	name, openDSN := sqlDriver(*driver, *dsn)
	db, err := sql.Open(name, openDSN)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_CONNECT: %w", err))
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		fail(fmt.Errorf("MIGRATION_CONNECT: driver=%s dsn=%s: %w", *driver, redactDSN(*dsn), err))
	}
	live, err := liveManifest(db, *driver)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_INTROSPECT: driver=%s: %w", *driver, err))
	}
	if !schemaMatches(want, live, *driver) {
		fail(fmt.Errorf("MIGRATION_VERIFY_FAILED: expected_schema_hash=%s actual_schema_hash=%s", want.SchemaHash, live.SchemaHash))
	}
	fmt.Printf("status=verified schema_hash=%s\n", want.SchemaHash)
}

func applyCmd(args []string) {
	fs := flag.NewFlagSet("apply", flag.ExitOnError)
	planPath := fs.String("plan", "", "migration plan JSON (required)")
	dsn := fs.String("dsn", "", "database DSN or SQLite path (required)")
	driver := fs.String("driver", "", "mysql|postgres|sqlite; defaults to plan driver")
	schemaPath := fs.String("schema", "", "target schema.json (required)")
	logDir := fs.String("log-dir", "migrations/logs", "directory for migration JSON logs")
	allow := fs.Bool("allow-destructive", false, "allow destructive operations listed in the plan")
	fs.Parse(args)
	if *planPath == "" || *dsn == "" || *schemaPath == "" {
		fail(fmt.Errorf("MIGRATION_CONFIG: --plan, --dsn and --schema are required"))
	}
	b, err := os.ReadFile(*planPath)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: read plan: %w", err))
	}
	var plan migrationPlanFile
	if err := json.Unmarshal(b, &plan); err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: invalid plan JSON: %w", err))
	}
	if plan.Version != 1 || plan.MigrationID == "" || plan.Driver == "" {
		fail(fmt.Errorf("MIGRATION_SOURCE: plan version, migration_id and driver are required"))
	}
	if *driver == "" {
		*driver = plan.Driver
	}
	if *driver != plan.Driver || (*driver != "mysql" && *driver != "postgres" && *driver != "sqlite") {
		fail(fmt.Errorf("MIGRATION_CONFIG: plan driver=%s does not match requested driver=%s", plan.Driver, *driver))
	}
	if checksumText(planSQL(plan.Operations)) != plan.Checksum {
		fail(fmt.Errorf("MIGRATION_PLAN: plan checksum mismatch"))
	}
	for _, operation := range plan.Operations {
		if operation.Destructive && !*allow {
			fail(fmt.Errorf("MIGRATION_PLAN: destructive operation requires --allow-destructive: %s", operation.SQL))
		}
	}
	want, err := loadManifestFile(*schemaPath)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: target schema: %w", err))
	}
	name, openDSN := sqlDriver(*driver, *dsn)
	db, err := sql.Open(name, openDSN)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_CONNECT: %w", err))
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		fail(fmt.Errorf("MIGRATION_CONNECT: driver=%s dsn=%s: %w", *driver, redactDSN(*dsn), err))
	}
	if err := ensureMigrationTable(ctx, db, *driver); err != nil {
		fail(err)
	}
	live, err := liveManifest(db, *driver)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_INTROSPECT: %w", err))
	}
	if plan.FromSchema != nil {
		if !schemaMatches(plan.FromSchema, live, *driver) {
			fail(fmt.Errorf("MIGRATION_PRECONDITION: source schema does not match live database expected_hash=%s actual_hash=%s", plan.FromHash, live.SchemaHash))
		}
	} else if live.SchemaHash != plan.FromHash {
		fail(fmt.Errorf("MIGRATION_PRECONDITION: expected_from_schema_hash=%s actual_schema_hash=%s", plan.FromHash, live.SchemaHash))
	}
	previous, found, err := appliedMigration(ctx, db, *driver, plan.MigrationID)
	if err != nil {
		fail(err)
	}
	if found {
		if previous.ToHash != plan.ToHash || previous.Checksum != plan.Checksum {
			fail(fmt.Errorf("MIGRATION_HISTORY_CONFLICT: migration_id=%s recorded_to=%s requested_to=%s recorded_plan_checksum=%s requested_plan_checksum=%s", plan.MigrationID, previous.ToHash, plan.ToHash, previous.Checksum, plan.Checksum))
		}
		if !schemaMatches(want, live, *driver) {
			fail(fmt.Errorf("MIGRATION_DRIFT: migration_id=%s expected_schema_hash=%s actual_schema_hash=%s", plan.MigrationID, want.SchemaHash, live.SchemaHash))
		}
		if err := verifyMigrationLog(*logDir, previous, *driver); err != nil {
			fail(err)
		}
		fmt.Printf("migration_id=%s status=noop operations=0 schema_hash=%s\n", plan.MigrationID, plan.ToHash)
		return
	}
	operations := len(plan.Operations)
	checksum := checksumText(planSQL(plan.Operations))
	record := migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.FromHash, ToHash: plan.ToHash, Checksum: checksum, Status: "applying", Operations: operations}
	startedAt := time.Now().UTC()
	if err := writeMigrationLog(*logDir, migrationLogFromRecord(record, *driver, startedAt, time.Time{})); err != nil {
		fail(err)
	}
	if err := insertMigration(ctx, db, *driver, record); err != nil {
		fail(err)
	}
	if err := executeMigration(ctx, db, planSQL(plan.Operations)); err != nil {
		detail := fmt.Sprintf("operation execution failed: %v", err)
		_ = updateMigration(ctx, db, *driver, plan.MigrationID, "failed", detail)
		_ = writeMigrationLog(*logDir, migrationLogFromRecord(record, *driver, startedAt, time.Now().UTC()).withError(detail))
		fail(fmt.Errorf("MIGRATION_APPLY_FAILED: migration_id=%s: %w", plan.MigrationID, err))
	}
	check, err := liveManifest(db, *driver)
	if err != nil || !schemaMatches(want, check, *driver) {
		detail := ""
		if err != nil {
			detail = err.Error()
		} else {
			detail = fmt.Sprintf("expected=%s actual=%s", want.SchemaHash, check.SchemaHash)
		}
		_ = updateMigration(ctx, db, *driver, plan.MigrationID, "failed", detail)
		_ = writeMigrationLog(*logDir, migrationLogFromRecord(record, *driver, startedAt, time.Now().UTC()).withError(detail))
		fail(fmt.Errorf("MIGRATION_VERIFY_FAILED: migration_id=%s %s", plan.MigrationID, detail))
	}
	if err := updateMigration(ctx, db, *driver, plan.MigrationID, "applied", ""); err != nil {
		fail(fmt.Errorf("MIGRATION_HISTORY_WRITE: %w", err))
	}
	if err := writeMigrationLog(*logDir, migrationLogFromRecord(migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.FromHash, ToHash: plan.ToHash, Checksum: checksum, Status: "applied", Operations: operations}, *driver, startedAt, time.Now().UTC())); err != nil {
		fail(err)
	}
	fmt.Printf("migration_id=%s status=applied operations=%d schema_hash=%s\n", plan.MigrationID, operations, plan.ToHash)
}
