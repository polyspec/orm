package ormgen

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/polyspec/orm/engine/schema"
)

func rollbackCmd(args []string) {
	fs := flag.NewFlagSet("rollback", flag.ExitOnError)
	planPath := fs.String("plan", "", "reviewed migration plan JSON (required)")
	dsnFlag := fs.String("dsn", "", "database DSN URI: mysql://, postgres://, or sqlite:///path (required)")
	logDir := fs.String("log-dir", "migrations/logs", "directory for migration JSON logs")
	allow := fs.Bool("allow-destructive", false, "acknowledge schema and data loss risk")
	fs.Parse(args)
	if *planPath == "" || *dsnFlag == "" {
		fail(fmt.Errorf("MIGRATION_CONFIG: --plan and --dsn are required"))
	}
	b, err := os.ReadFile(*planPath)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: read rollback plan: %w", err))
	}
	var plan migrationPlanFile
	if err := json.Unmarshal(b, &plan); err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: invalid plan JSON: %w", err))
	}
	if err := validateRollbackPlan(plan); err != nil {
		fail(err)
	}
	dsn, err := parseToolDSN(*dsnFlag)
	if err != nil {
		fail(err)
	}
	if dsn.dialect != plan.Driver {
		fail(fmt.Errorf("MIGRATION_CONFIG: plan driver=%s does not match the DSN driver=%s", plan.Driver, dsn.dialect))
	}
	if plan.RollbackDataLossRisk && !*allow {
		fail(fmt.Errorf("MIGRATION_ROLLBACK_DESTRUCTIVE: migration_id=%s requires --allow-destructive; schema rollback does not restore removed or overwritten data", plan.MigrationID))
	}
	db, _, err := openToolDB(*dsnFlag)
	if err != nil {
		fail(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	status, err := rollbackMigration(ctx, db, plan, *logDir)
	if err != nil {
		fail(err)
	}
	fmt.Printf("migration_id=%s status=%s schema_hash=%s operations=%d\n", plan.MigrationID, status, plan.FromHash, len(plan.RollbackOperations))
}

func validateRollbackPlan(plan migrationPlanFile) error {
	if plan.Version != 1 || plan.MigrationID == "" || plan.Driver == "" || plan.FromSchema == nil || plan.ToSchema == nil {
		return fmt.Errorf("MIGRATION_ROLLBACK_PLAN: version, migration_id, driver, from_schema, and to_schema are required")
	}
	if plan.FromSchema.SchemaHash != plan.FromHash || plan.ToSchema.SchemaHash != plan.ToHash {
		return fmt.Errorf("MIGRATION_ROLLBACK_PLAN: embedded schema hash mismatch")
	}
	for label, manifest := range map[string]any{"from_schema": plan.FromSchema, "to_schema": plan.ToSchema} {
		encoded, err := json.Marshal(manifest)
		if err != nil {
			return fmt.Errorf("MIGRATION_ROLLBACK_PLAN: encode %s: %w", label, err)
		}
		if _, err := schema.Load(encoded); err != nil {
			return fmt.Errorf("MIGRATION_ROLLBACK_PLAN: invalid %s: %w", label, err)
		}
	}
	if err := validatePlanOperations("MIGRATION_PLAN", plan.Operations, plan.Checksum); err != nil {
		return err
	}
	if err := validatePlanOperations("MIGRATION_ROLLBACK_PLAN", plan.RollbackOperations, plan.RollbackChecksum); err != nil {
		return err
	}
	wantRisk := hasDestructive(plan.Operations) || hasDestructive(plan.RollbackOperations)
	if plan.RollbackDataLossRisk != wantRisk {
		return fmt.Errorf("MIGRATION_ROLLBACK_PLAN: rollback_data_loss_risk mismatch expected=%t actual=%t", wantRisk, plan.RollbackDataLossRisk)
	}
	return nil
}

func rollbackMigration(ctx context.Context, db *sql.DB, plan migrationPlanFile, logDir string) (string, error) {
	if err := ensureMigrationTable(ctx, db, plan.Driver); err != nil {
		return "", err
	}
	record, found, err := migrationByID(ctx, db, plan.Driver, plan.MigrationID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", fmt.Errorf("MIGRATION_HISTORY_MISSING: migration_id=%s", plan.MigrationID)
	}
	if err := verifyPlanRecord(plan, record); err != nil {
		return "", err
	}
	live, err := liveManifest(db, plan.Driver)
	if err != nil {
		return "", fmt.Errorf("MIGRATION_INTROSPECT: migration_id=%s: %w", plan.MigrationID, err)
	}
	if record.Status == "rolled_back" {
		if !schemaMatches(plan.FromSchema, live, plan.Driver) {
			return "", fmt.Errorf("MIGRATION_ROLLBACK_DRIFT: migration_id=%s expected_source_hash=%s actual_schema_hash=%s", plan.MigrationID, plan.FromHash, live.SchemaHash)
		}
		rollbackRecord := migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.ToHash, ToHash: plan.FromHash, Checksum: plan.RollbackChecksum, Status: "rolled_back", Operations: len(plan.RollbackOperations)}
		if err := verifyMigrationLog(logDir, rollbackRecord, plan.Driver); err != nil {
			return "", err
		}
		return "noop", nil
	}
	if record.Status != "applied" {
		return "", fmt.Errorf("MIGRATION_ROLLBACK_STATE: migration_id=%s status=%s expected=applied", plan.MigrationID, record.Status)
	}
	if !schemaMatches(plan.ToSchema, live, plan.Driver) {
		return "", fmt.Errorf("MIGRATION_ROLLBACK_PRECONDITION: migration_id=%s expected_target_hash=%s actual_schema_hash=%s", plan.MigrationID, plan.ToHash, live.SchemaHash)
	}
	started := time.Now().UTC()
	rollbackRecord := migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.ToHash, ToHash: plan.FromHash, Checksum: plan.RollbackChecksum, Status: "rolling_back", Operations: len(plan.RollbackOperations)}
	if err := writeMigrationLog(logDir, migrationLogFromRecord(rollbackRecord, plan.Driver, started, time.Time{})); err != nil {
		return "", err
	}
	claimed := false
	err = withMigrationLock(ctx, db, plan.Driver, func(conn *sql.Conn) error {
		if err := transitionMigration(ctx, conn, plan.Driver, plan.MigrationID, "applied", "rolling_back", ""); err != nil {
			return err
		}
		claimed = true
		for i, operation := range plan.RollbackOperations {
			for _, statement := range splitSQL(operation.SQL) {
				if _, err := conn.ExecContext(ctx, statement); err != nil {
					return fmt.Errorf("rollback_operation=%d statement=%q: %w", i+1, statement, err)
				}
			}
		}
		return nil
	})
	if err != nil {
		detail := err.Error()
		if claimed {
			if markErr := markRollbackFailed(ctx, db, plan.Driver, plan.MigrationID, detail); markErr != nil {
				detail += "; history_error=" + markErr.Error()
			}
			rollbackRecord.Status = "rollback_failed"
			_ = writeMigrationLog(logDir, migrationLogFromRecord(rollbackRecord, plan.Driver, started, time.Now().UTC()).withError(detail))
		}
		return "", fmt.Errorf("MIGRATION_ROLLBACK_FAILED: migration_id=%s: %w", plan.MigrationID, err)
	}
	live, err = liveManifest(db, plan.Driver)
	if err != nil || !schemaMatches(plan.FromSchema, live, plan.Driver) {
		detail := ""
		if err != nil {
			detail = err.Error()
		} else {
			detail = fmt.Sprintf("expected=%s actual=%s", plan.FromHash, live.SchemaHash)
		}
		_ = transitionMigration(ctx, db, plan.Driver, plan.MigrationID, "rolling_back", "rollback_failed", detail)
		return "", fmt.Errorf("MIGRATION_ROLLBACK_VERIFY_FAILED: migration_id=%s %s", plan.MigrationID, detail)
	}
	if err := transitionMigration(ctx, db, plan.Driver, plan.MigrationID, "rolling_back", "rolled_back", ""); err != nil {
		return "", fmt.Errorf("MIGRATION_HISTORY_WRITE: migration_id=%s rollback: %w", plan.MigrationID, err)
	}
	rollbackRecord.Status = "rolled_back"
	if err := writeMigrationLog(logDir, migrationLogFromRecord(rollbackRecord, plan.Driver, started, time.Now().UTC())); err != nil {
		return "", err
	}
	return "rolled_back", nil
}

func markRollbackFailed(ctx context.Context, db *sql.DB, driver, id, detail string) error {
	query := "UPDATE orm_schema_migrations SET status=" + placeholder(driver, 1) + ", error_detail=" + placeholder(driver, 2) + ", finished_at=CURRENT_TIMESTAMP WHERE migration_id=" + placeholder(driver, 3) + " AND status IN (" + placeholder(driver, 4) + "," + placeholder(driver, 5) + ")"
	result, err := db.ExecContext(ctx, query, "rollback_failed", detail, id, "applied", "rolling_back")
	if err != nil {
		return fmt.Errorf("MIGRATION_HISTORY_WRITE: migration_id=%s mark_rollback_failed: %w", id, err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("MIGRATION_HISTORY_WRITE: migration_id=%s mark_rollback_failed rows: %w", id, err)
	}
	if rows != 1 {
		return fmt.Errorf("MIGRATION_STATE_CHANGED: migration_id=%s rollback failure status was not written affected_rows=%d", id, rows)
	}
	return nil
}
