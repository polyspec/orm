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

func recoverCmd(args []string) {
	fs := flag.NewFlagSet("recover", flag.ExitOnError)
	planPath := fs.String("plan", "", "migration plan JSON (required)")
	migrationID := fs.String("migration-id", "", "migration identifier recorded by ormgen migrate")
	dsnFlag := fs.String("dsn", "", "database DSN URI: mysql://, postgres://, or sqlite:///path (required)")
	schemaPath := fs.String("schema", "", "target schema.json (required)")
	logDir := fs.String("log-dir", "migrations/logs", "directory for migration JSON logs")
	fs.Parse(args)
	if (*planPath == "") == (*migrationID == "") || *dsnFlag == "" || *schemaPath == "" {
		fail(fmt.Errorf("MIGRATION_CONFIG: exactly one of --plan or --migration-id, plus --dsn and --schema, is required"))
	}
	dsn, err := parseToolDSN(*dsnFlag)
	if err != nil {
		fail(err)
	}
	driver := dsn.dialect
	var plan migrationPlanFile
	if *planPath != "" {
		b, err := os.ReadFile(*planPath)
		if err != nil {
			fail(fmt.Errorf("MIGRATION_SOURCE: read plan: %w", err))
		}
		if err := json.Unmarshal(b, &plan); err != nil {
			fail(fmt.Errorf("MIGRATION_SOURCE: invalid plan JSON: %w", err))
		}
		if plan.Version != 1 || plan.MigrationID == "" || plan.Driver == "" {
			fail(fmt.Errorf("MIGRATION_SOURCE: plan version, migration_id and driver are required"))
		}
		if driver != plan.Driver {
			fail(fmt.Errorf("MIGRATION_CONFIG: plan driver=%s does not match the DSN driver=%s", plan.Driver, driver))
		}
		if checksumText(planSQL(plan.Operations)) != plan.Checksum {
			fail(fmt.Errorf("MIGRATION_PLAN: plan checksum mismatch"))
		}
	}
	want, err := loadSchemaSource(*schemaPath, driver)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: target schema: %w", err))
	}
	if *planPath != "" && want.SchemaHash != plan.ToHash {
		fail(fmt.Errorf("MIGRATION_PLAN: target manifest hash does not match plan expected_hash=%s actual_hash=%s", plan.ToHash, want.SchemaHash))
	}
	db, _, err := openToolDB(*dsnFlag)
	if err != nil {
		fail(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	status := ""
	if *planPath != "" {
		status, err = recoverMigration(ctx, db, driver, plan, want, *logDir)
		*migrationID = plan.MigrationID
	} else {
		status, err = recoverMigrationByID(ctx, db, driver, *migrationID, want, *logDir)
	}
	if err != nil {
		fail(err)
	}
	fmt.Printf("migration_id=%s status=%s schema_hash=%s\n", *migrationID, status, want.SchemaHash)
}

func verifyPlanRecord(plan migrationPlanFile, record migrationRecord) error {
	if record.FromHash != plan.FromHash || record.ToHash != plan.ToHash || record.Checksum != plan.Checksum || record.Operations != len(plan.Operations) {
		return fmt.Errorf("MIGRATION_HISTORY_CONFLICT: migration_id=%s recorded_from=%s requested_from=%s recorded_to=%s requested_to=%s recorded_plan_checksum=%s requested_plan_checksum=%s recorded_operations=%d requested_operations=%d", plan.MigrationID, record.FromHash, plan.FromHash, record.ToHash, plan.ToHash, record.Checksum, plan.Checksum, record.Operations, len(plan.Operations))
	}
	return nil
}

func recoverMigration(ctx context.Context, db *sql.DB, driver string, plan migrationPlanFile, want *schema.Manifest, logDir string) (string, error) {
	if err := ensureMigrationTable(ctx, db, driver); err != nil {
		return "", err
	}
	result := ""
	var recoveredLog *migrationLog
	err := withMigrationLock(ctx, db, driver, func(conn *sql.Conn) error {
		record, found, err := migrationByID(ctx, conn, driver, plan.MigrationID)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("MIGRATION_HISTORY_MISSING: migration_id=%s cannot recover a migration without a database history record", plan.MigrationID)
		}
		if err := verifyPlanRecord(plan, record); err != nil {
			return err
		}
		live, err := liveManifest(db, driver)
		if err != nil {
			return fmt.Errorf("MIGRATION_INTROSPECT: migration_id=%s: %w", plan.MigrationID, err)
		}
		atTarget := schemaMatches(want, live, driver)
		atSource := plan.FromSchema != nil && schemaMatches(plan.FromSchema, live, driver)
		if plan.FromSchema == nil {
			atSource = live.SchemaHash == plan.FromHash
		}
		now := time.Now().UTC()
		switch {
		case atTarget:
			if record.Status == "applied" {
				if err := verifyMigrationLog(logDir, record, driver); err != nil {
					return err
				}
				result = "noop"
				return nil
			}
			if record.Status != "queued" && record.Status != "applying" && record.Status != "failed" && record.Status != "retryable" {
				return fmt.Errorf("MIGRATION_STATE_INVALID: migration_id=%s status=%s", plan.MigrationID, record.Status)
			}
			if err := transitionMigration(ctx, conn, driver, plan.MigrationID, record.Status, "applied", ""); err != nil {
				return err
			}
			record.Status = "applied"
			log := migrationLogFromRecord(record, driver, now, now)
			recoveredLog = &log
			result = "applied"
			return nil
		case atSource:
			if record.Status == "applied" {
				return fmt.Errorf("MIGRATION_DRIFT: migration_id=%s status=applied expected_schema_hash=%s actual_schema_hash=%s", plan.MigrationID, plan.ToHash, live.SchemaHash)
			}
			if record.Status == "retryable" {
				if err := verifyMigrationLog(logDir, record, driver); err != nil {
					return err
				}
				result = "noop"
				return nil
			}
			if record.Status != "queued" && record.Status != "applying" && record.Status != "failed" {
				return fmt.Errorf("MIGRATION_STATE_INVALID: migration_id=%s status=%s", plan.MigrationID, record.Status)
			}
			detail := "live database matches the source schema; exact plan retry is permitted"
			if err := transitionMigration(ctx, conn, driver, plan.MigrationID, record.Status, "retryable", detail); err != nil {
				return err
			}
			record.Status = "retryable"
			log := migrationLogFromRecord(record, driver, now, now).withError(detail)
			recoveredLog = &log
			result = "retryable"
			return nil
		default:
			return fmt.Errorf("MIGRATION_RECOVERY_UNSAFE: migration_id=%s status=%s expected_source_hash=%s expected_target_hash=%s actual_schema_hash=%s; database and file logs were not modified", plan.MigrationID, record.Status, plan.FromHash, plan.ToHash, live.SchemaHash)
		}
	})
	if err != nil {
		return "", err
	}
	if recoveredLog != nil {
		if err := writeMigrationLog(logDir, *recoveredLog); err != nil {
			return "", err
		}
	}
	return result, nil
}

func recoverMigrationByID(ctx context.Context, db *sql.DB, driver, migrationID string, want *schema.Manifest, logDir string) (string, error) {
	if err := ensureMigrationTable(ctx, db, driver); err != nil {
		return "", err
	}
	result := ""
	var recoveredLog *migrationLog
	err := withMigrationLock(ctx, db, driver, func(conn *sql.Conn) error {
		record, found, err := migrationByID(ctx, conn, driver, migrationID)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("MIGRATION_HISTORY_MISSING: migration_id=%s cannot recover a migration without a database history record", migrationID)
		}
		if record.ToHash != want.SchemaHash {
			return fmt.Errorf("MIGRATION_HISTORY_CONFLICT: migration_id=%s recorded_to=%s requested_to=%s", migrationID, record.ToHash, want.SchemaHash)
		}
		live, err := liveManifest(db, driver)
		if err != nil {
			return fmt.Errorf("MIGRATION_INTROSPECT: migration_id=%s: %w", migrationID, err)
		}
		atTarget := schemaMatches(want, live, driver)
		atSource := live.SchemaHash == record.FromHash
		now := time.Now().UTC()
		switch {
		case atTarget:
			if record.Status == "applied" {
				if err := verifyMigrationLog(logDir, record, driver); err != nil {
					return err
				}
				result = "noop"
				return nil
			}
			if record.Status != "queued" && record.Status != "applying" && record.Status != "failed" && record.Status != "retryable" {
				return fmt.Errorf("MIGRATION_STATE_INVALID: migration_id=%s status=%s", migrationID, record.Status)
			}
			if err := transitionMigration(ctx, conn, driver, migrationID, record.Status, "applied", ""); err != nil {
				return err
			}
			record.Status = "applied"
			log := migrationLogFromRecord(record, driver, now, now)
			recoveredLog = &log
			result = "applied"
			return nil
		case atSource:
			if record.Status == "applied" {
				return fmt.Errorf("MIGRATION_DRIFT: migration_id=%s status=applied expected_schema_hash=%s actual_schema_hash=%s", migrationID, record.ToHash, live.SchemaHash)
			}
			if record.Status == "retryable" {
				if err := verifyMigrationLog(logDir, record, driver); err != nil {
					return err
				}
				result = "noop"
				return nil
			}
			if record.Status != "queued" && record.Status != "applying" && record.Status != "failed" {
				return fmt.Errorf("MIGRATION_STATE_INVALID: migration_id=%s status=%s", migrationID, record.Status)
			}
			detail := "live database matches the recorded source schema; deterministic migration retry is permitted"
			if err := transitionMigration(ctx, conn, driver, migrationID, record.Status, "retryable", detail); err != nil {
				return err
			}
			record.Status = "retryable"
			log := migrationLogFromRecord(record, driver, now, now).withError(detail)
			recoveredLog = &log
			result = "retryable"
			return nil
		default:
			return fmt.Errorf("MIGRATION_RECOVERY_UNSAFE: migration_id=%s status=%s expected_source_hash=%s expected_target_hash=%s actual_schema_hash=%s; database and file logs were not modified", migrationID, record.Status, record.FromHash, record.ToHash, live.SchemaHash)
		}
	})
	if err != nil {
		return "", err
	}
	if recoveredLog != nil {
		if err := writeMigrationLog(logDir, *recoveredLog); err != nil {
			return "", err
		}
	}
	return result, nil
}
