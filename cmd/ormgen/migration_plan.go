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
)

type migrationPlanFile struct {
	Version     int             `json:"version"`
	MigrationID string          `json:"migration_id"`
	Name        string          `json:"name"`
	Driver      string          `json:"driver"`
	FromHash    string          `json:"from_schema_hash"`
	ToHash      string          `json:"to_schema_hash"`
	Checksum    string          `json:"plan_checksum"`
	Operations  []planOperation `json:"operations"`
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
	plan := migrationPlanFile{Version: 1, MigrationID: *id, Name: *name, Driver: *dialect, FromHash: from.SchemaHash, ToHash: to.SchemaHash, Operations: operations}
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
