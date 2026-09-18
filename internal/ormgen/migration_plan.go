package ormgen

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/engine/schema"
)

type migrationPlanFile struct {
	Version              int              `json:"version"`
	MigrationID          string           `json:"migration_id"`
	Name                 string           `json:"name"`
	Driver               string           `json:"driver"`
	FromHash             string           `json:"from_schema_hash"`
	FromSchema           *schema.Manifest `json:"from_schema"`
	ToHash               string           `json:"to_schema_hash"`
	ToSchema             *schema.Manifest `json:"to_schema"`
	Checksum             string           `json:"plan_checksum"`
	Operations           []planOperation  `json:"operations"`
	RollbackChecksum     string           `json:"rollback_checksum"`
	RollbackOperations   []planOperation  `json:"rollback_operations"`
	RollbackDataLossRisk bool             `json:"rollback_data_loss_risk"`
}

type planOperation struct {
	SQL         string `json:"sql"`
	Destructive bool   `json:"destructive"`
}

func planCmd(args []string) {
	fs := flag.NewFlagSet("plan", flag.ExitOnError)
	fromPath := fs.String("from", "", "previous .mmd, .json, ormgen .sql, or db:<dsn> (required)")
	toPath := fs.String("to", "", "target .mmd, .json, ormgen .sql, or db:<dsn> (required)")
	dialect := fs.String("dialect", "mysql", "mysql|postgres|sqlite")
	out := fs.String("out", "", "output migration plan JSON (required)")
	id := fs.String("migration-id", "", "stable migration identifier")
	name := fs.String("name", "schema migration", "migration name")
	fs.Parse(args)
	if *fromPath == "" || *toPath == "" || *out == "" {
		fail(fmt.Errorf("MIGRATION_CONFIG: --from, --to and --out are required"))
	}
	resolvedID, err := migrationPlanID(*out, *id)
	if err != nil {
		fail(err)
	}
	*id = resolvedID
	from, err := loadSchemaSource(*fromPath, *dialect)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: from: %w", err))
	}
	to, err := loadSchemaSource(*toPath, *dialect)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: to: %w", err))
	}
	if err := alignSourceChecks(*fromPath, *toPath, from, to); err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: %w", err))
	}
	b, err := buildMigrationPlan(from, to, *dialect, *id, *name)
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile(*out, b, 0o644); err != nil {
		fail(fmt.Errorf("MIGRATION_PLAN: write %s: %w", *out, err))
	}
}

// buildMigrationPlan renders the plan file written by ormgen plan.
func buildMigrationPlan(from, to *schema.Manifest, dialect, id, name string) ([]byte, error) {
	sqlText, err := renderDiff(from, to, dialect, true)
	if err != nil {
		return nil, fmt.Errorf("MIGRATION_PLAN: %w", err)
	}
	rollbackText, err := renderDiff(to, from, dialect, true)
	if err != nil {
		return nil, fmt.Errorf("MIGRATION_ROLLBACK_PLAN: %w", err)
	}
	operations := planOperations(sqlText)
	rollbackOperations := planOperations(rollbackText)
	plan := migrationPlanFile{Version: 1, MigrationID: id, Name: name, Driver: dialect, FromHash: from.SchemaHash, FromSchema: from, ToHash: to.SchemaHash, ToSchema: to, Operations: operations, RollbackOperations: rollbackOperations}
	plan.Checksum = checksumText(planSQL(operations))
	plan.RollbackChecksum = checksumText(planSQL(rollbackOperations))
	plan.RollbackDataLossRisk = hasDestructive(operations) || hasDestructive(rollbackOperations)
	b, err := json.MarshalIndent(plan, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("MIGRATION_PLAN: encode: %w", err)
	}
	return append(b, '\n'), nil
}

var migrationPlanName = regexp.MustCompile(`^[0-9]{8}-[a-z0-9][a-z0-9._-]*$`)

func migrationPlanID(out, requested string) (string, error) {
	base := filepath.Base(out)
	if filepath.Ext(base) != ".json" {
		return "", fmt.Errorf("MIGRATION_FILE_NAME: plan file must use YYYYMMDD-name.json: %s", base)
	}
	fileID := strings.TrimSuffix(base, ".json")
	if !migrationPlanName.MatchString(fileID) {
		return "", fmt.Errorf("MIGRATION_FILE_NAME: plan file must use YYYYMMDD-name.json: %s", base)
	}
	if _, err := time.Parse("20060102", fileID[:8]); err != nil {
		return "", fmt.Errorf("MIGRATION_FILE_NAME: invalid YYYYMMDD date in %s", base)
	}
	if requested != "" && requested != fileID {
		return "", fmt.Errorf("MIGRATION_FILE_NAME: migration_id=%s must match plan filename id=%s", requested, fileID)
	}
	return fileID, nil
}

func planOperations(sqlText string) []planOperation {
	operations := make([]planOperation, 0)
	for _, statement := range splitSQL(sqlText) {
		upper := strings.ToUpper(statement)
		operations = append(operations, planOperation{SQL: statement + ";", Destructive: strings.Contains(upper, "DROP TABLE") || strings.Contains(upper, "DROP COLUMN") || strings.Contains(upper, "MODIFY COLUMN") || strings.Contains(upper, "ALTER COLUMN")})
	}
	return operations
}

func validatePlanOperations(label string, operations []planOperation, checksum string) error {
	if checksumText(planSQL(operations)) != checksum {
		return fmt.Errorf("%s: plan checksum mismatch", label)
	}
	for i, operation := range operations {
		classified := planOperations(operation.SQL)
		if len(classified) != 1 {
			return fmt.Errorf("%s: operation=%d must contain exactly one SQL statement", label, i+1)
		}
		if operation.Destructive != classified[0].Destructive {
			return fmt.Errorf("%s: operation=%d destructive flag mismatch", label, i+1)
		}
	}
	return nil
}

func hasDestructive(operations []planOperation) bool {
	for _, operation := range operations {
		if operation.Destructive {
			return true
		}
	}
	return false
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
	dsnFlag := fs.String("dsn", "", "database DSN URI: mysql://, postgres://, or sqlite:///path (required)")
	schemaPath := fs.String("schema", "", "target schema.json (required)")
	fs.Parse(args)
	if *dsnFlag == "" || *schemaPath == "" {
		fail(fmt.Errorf("MIGRATION_CONFIG: --dsn and --schema are required"))
	}
	db, dsn, err := openToolDB(*dsnFlag)
	if err != nil {
		fail(err)
	}
	defer db.Close()
	driver := dsn.dialect
	want, err := loadSchemaSource(*schemaPath, driver)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: %w", err))
	}
	live, err := liveManifest(db, driver)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_INTROSPECT: driver=%s: %w", driver, err))
	}
	if !schemaMatches(want, live, driver) {
		fail(fmt.Errorf("MIGRATION_VERIFY_FAILED: expected_schema_hash=%s actual_schema_hash=%s", want.SchemaHash, live.SchemaHash))
	}
	fmt.Printf("status=verified schema_hash=%s\n", want.SchemaHash)
}

func applyCmd(args []string) {
	fs := flag.NewFlagSet("apply", flag.ExitOnError)
	planPath := fs.String("plan", "", "migration plan JSON (required)")
	dsnFlag := fs.String("dsn", "", "database DSN URI: mysql://, postgres://, or sqlite:///path (required)")
	schemaPath := fs.String("schema", "", "target schema.json (required)")
	logDir := fs.String("log-dir", "migrations/logs", "directory for migration JSON logs")
	allow := fs.Bool("allow-destructive", false, "allow destructive operations listed in the plan")
	fs.Parse(args)
	if *planPath == "" || *dsnFlag == "" || *schemaPath == "" {
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
	dsn, err := parseToolDSN(*dsnFlag)
	if err != nil {
		fail(err)
	}
	driver := dsn.dialect
	if driver != plan.Driver {
		fail(fmt.Errorf("MIGRATION_CONFIG: plan driver=%s does not match the DSN driver=%s", plan.Driver, driver))
	}
	if err := validatePlanOperations("MIGRATION_PLAN", plan.Operations, plan.Checksum); err != nil {
		fail(err)
	}
	if plan.ToSchema != nil || len(plan.RollbackOperations) > 0 || plan.RollbackChecksum != "" {
		if err := validateRollbackPlan(plan); err != nil {
			fail(err)
		}
	}
	for _, operation := range plan.Operations {
		if operation.Destructive && !*allow {
			fail(fmt.Errorf("MIGRATION_PLAN: destructive operation requires --allow-destructive: %s", operation.SQL))
		}
	}
	want, err := loadSchemaSource(*schemaPath, driver)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: target schema: %w", err))
	}
	if want.SchemaHash != plan.ToHash {
		fail(fmt.Errorf("MIGRATION_PLAN: target manifest hash does not match plan expected_hash=%s actual_hash=%s", plan.ToHash, want.SchemaHash))
	}
	db, _, err := openToolDB(*dsnFlag)
	if err != nil {
		fail(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := ensureMigrationTable(ctx, db, driver); err != nil {
		fail(err)
	}
	live, err := liveManifest(db, driver)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_INTROSPECT: %w", err))
	}
	previous, found, err := migrationByID(ctx, db, driver, plan.MigrationID)
	if err != nil {
		fail(err)
	}
	if found {
		if err := verifyPlanRecord(plan, previous); err != nil {
			fail(err)
		}
		switch previous.Status {
		case "applied":
			if !schemaMatches(want, live, driver) {
				fail(fmt.Errorf("MIGRATION_DRIFT: migration_id=%s status=applied expected_schema_hash=%s actual_schema_hash=%s", plan.MigrationID, want.SchemaHash, live.SchemaHash))
			}
			if err := verifyMigrationLog(*logDir, previous, driver); err != nil {
				fail(err)
			}
			fmt.Printf("migration_id=%s status=noop operations=0 schema_hash=%s\n", plan.MigrationID, plan.ToHash)
			return
		case "retryable", "rolled_back":
			// The source check below must pass before this row can return to applying.
		case "queued", "applying", "failed":
			fail(fmt.Errorf("MIGRATION_RECOVERY_REQUIRED: migration_id=%s status=%s run ormgen recover with the same plan and target schema", plan.MigrationID, previous.Status))
		default:
			fail(fmt.Errorf("MIGRATION_STATE_INVALID: migration_id=%s status=%s", plan.MigrationID, previous.Status))
		}
	}
	if plan.FromSchema != nil {
		if !schemaMatches(plan.FromSchema, live, driver) {
			fail(fmt.Errorf("MIGRATION_PRECONDITION: source schema does not match live database expected_hash=%s actual_hash=%s", plan.FromHash, live.SchemaHash))
		}
	} else if live.SchemaHash != plan.FromHash {
		fail(fmt.Errorf("MIGRATION_PRECONDITION: expected_from_schema_hash=%s actual_schema_hash=%s", plan.FromHash, live.SchemaHash))
	}
	operations := len(plan.Operations)
	checksum := checksumText(planSQL(plan.Operations))
	record := migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.FromHash, ToHash: plan.ToHash, Checksum: checksum, Status: "queued", Operations: operations}
	startedAt := time.Now().UTC()
	if err := writeMigrationLog(*logDir, migrationLogFromRecord(record, driver, startedAt, time.Time{})); err != nil {
		fail(err)
	}
	expectedStatus := "queued"
	if found {
		expectedStatus = previous.Status
	} else {
		if err := insertMigration(ctx, db, driver, record); err != nil {
			fail(err)
		}
	}
	if err := executeClaimedMigration(ctx, db, driver, plan.MigrationID, expectedStatus, planSQL(plan.Operations)); err != nil {
		detail := fmt.Sprintf("operation execution failed: %v", err)
		_ = markMigrationFailed(ctx, db, driver, plan.MigrationID, detail)
		failedRecord := record
		failedRecord.Status = "failed"
		_ = writeMigrationLog(*logDir, migrationLogFromRecord(failedRecord, driver, startedAt, time.Now().UTC()).withError(detail))
		fail(fmt.Errorf("MIGRATION_APPLY_FAILED: migration_id=%s: %w", plan.MigrationID, err))
	}
	check, err := liveManifest(db, driver)
	if err != nil || !schemaMatches(want, check, driver) {
		detail := ""
		if err != nil {
			detail = err.Error()
		} else {
			detail = fmt.Sprintf("expected=%s actual=%s", want.SchemaHash, check.SchemaHash)
		}
		_ = updateMigration(ctx, db, driver, plan.MigrationID, "failed", detail)
		_ = writeMigrationLog(*logDir, migrationLogFromRecord(record, driver, startedAt, time.Now().UTC()).withError(detail))
		fail(fmt.Errorf("MIGRATION_VERIFY_FAILED: migration_id=%s %s", plan.MigrationID, detail))
	}
	if err := updateMigration(ctx, db, driver, plan.MigrationID, "applied", ""); err != nil {
		fail(fmt.Errorf("MIGRATION_HISTORY_WRITE: %w", err))
	}
	if err := writeMigrationLog(*logDir, migrationLogFromRecord(migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.FromHash, ToHash: plan.ToHash, Checksum: checksum, Status: "applied", Operations: operations}, driver, startedAt, time.Now().UTC())); err != nil {
		fail(err)
	}
	fmt.Printf("migration_id=%s status=applied operations=%d schema_hash=%s\n", plan.MigrationID, operations, plan.ToHash)
}
