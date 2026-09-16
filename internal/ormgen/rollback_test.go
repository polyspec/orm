package ormgen

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestRollbackMigrationAppliesAndRepeatsAsNoop(t *testing.T) {
	ctx, db, plan, logDir := prepareSQLiteRollback(t)
	defer db.Close()

	status, err := rollbackMigration(ctx, db, plan, logDir)
	if err != nil || status != "rolled_back" {
		t.Fatalf("status=%s err=%v", status, err)
	}
	live, err := liveManifest(db, "sqlite")
	if err != nil || !schemaMatches(plan.FromSchema, live, "sqlite") {
		t.Fatalf("rollback schema mismatch: live=%v err=%v", live, err)
	}
	record, found, err := migrationByID(ctx, db, "sqlite", plan.MigrationID)
	if err != nil || !found || record.Status != "rolled_back" {
		t.Fatalf("record=%#v found=%v err=%v", record, found, err)
	}
	rollbackRecord := migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.ToHash, ToHash: plan.FromHash, Checksum: plan.RollbackChecksum, Status: "rolled_back", Operations: len(plan.RollbackOperations)}
	if err := verifyMigrationLog(logDir, rollbackRecord, "sqlite"); err != nil {
		t.Fatal(err)
	}
	status, err = rollbackMigration(ctx, db, plan, logDir)
	if err != nil || status != "noop" {
		t.Fatalf("repeat status=%s err=%v", status, err)
	}
}

func TestRollbackMigrationRejectsUnsafeState(t *testing.T) {
	ctx, db, plan, logDir := prepareSQLiteRollback(t)
	defer db.Close()
	if _, err := db.ExecContext(ctx, `ALTER TABLE "rollback_probe" ADD COLUMN "external_drift" TEXT`); err != nil {
		t.Fatal(err)
	}
	_, err := rollbackMigration(ctx, db, plan, logDir)
	if err == nil || !strings.Contains(err.Error(), "MIGRATION_ROLLBACK_PRECONDITION") {
		t.Fatalf("error=%v", err)
	}
	record, found, readErr := migrationByID(ctx, db, "sqlite", plan.MigrationID)
	if readErr != nil || !found || record.Status != "applied" {
		t.Fatalf("record=%#v found=%v err=%v", record, found, readErr)
	}
}

func TestRollbackPlanRejectsTamperedRiskAndOperations(t *testing.T) {
	base := testMigrationManifest(t, "erDiagram\n  rollback_validation {\n    bigint seq PK\n  }\n")
	target := testMigrationManifest(t, "erDiagram\n  rollback_validation {\n    bigint seq PK\n    text note \"?\"\n  }\n")
	diff, err := renderDiff(base, target, "sqlite", true)
	if err != nil {
		t.Fatal(err)
	}
	plan := testMigrationPlan(base, target, "sqlite", diff)
	plan.RollbackDataLossRisk = false
	if err := validateRollbackPlan(plan); err == nil || !strings.Contains(err.Error(), "rollback_data_loss_risk mismatch") {
		t.Fatalf("risk error=%v", err)
	}
	plan.RollbackDataLossRisk = true
	changed := false
	for i := range plan.RollbackOperations {
		if plan.RollbackOperations[i].Destructive {
			plan.RollbackOperations[i].Destructive = false
			changed = true
			break
		}
	}
	if !changed {
		t.Fatal("rollback plan has no destructive operation")
	}
	if err := validateRollbackPlan(plan); err == nil || !strings.Contains(err.Error(), "destructive flag mismatch") {
		t.Fatalf("operation error=%v", err)
	}
}

func TestRollbackPlanRejectsTamperedEmbeddedManifest(t *testing.T) {
	base := testMigrationManifest(t, "erDiagram\n  rollback_manifest {\n    bigint seq PK\n  }\n")
	target := testMigrationManifest(t, "erDiagram\n  rollback_manifest {\n    bigint seq PK\n    text note \"?\"\n  }\n")
	diff, err := renderDiff(base, target, "sqlite", true)
	if err != nil {
		t.Fatal(err)
	}
	plan := testMigrationPlan(base, target, "sqlite", diff)
	plan.ToSchema.Entities["rollback_manifest"].Comment = "modified"
	if err := validateRollbackPlan(plan); err == nil || !strings.Contains(err.Error(), "invalid to_schema") {
		t.Fatalf("error=%v", err)
	}
}

func TestMigrationPlanFilenameDefinesID(t *testing.T) {
	id, err := migrationPlanID("migrations/20260912-add-note.json", "")
	if err != nil || id != "20260912-add-note" {
		t.Fatalf("id=%s err=%v", id, err)
	}
	for _, tc := range []struct{ file, id string }{
		{"migration.json", ""},
		{"20261340-invalid.json", ""},
		{"20260912-add-note.json", "different"},
		{"20260912-add-note.sql", ""},
	} {
		if _, err := migrationPlanID(tc.file, tc.id); err == nil || !strings.Contains(err.Error(), "MIGRATION_FILE_NAME") {
			t.Fatalf("file=%s id=%s error=%v", tc.file, tc.id, err)
		}
	}
}

func TestRollbackMigrationRecordsStatementFailure(t *testing.T) {
	ctx, db, plan, logDir := prepareSQLiteRollback(t)
	defer db.Close()
	plan.RollbackOperations = []planOperation{{SQL: `DROP TABLE "missing_table";`, Destructive: true}}
	plan.RollbackChecksum = checksumText(planSQL(plan.RollbackOperations))
	_, err := rollbackMigration(ctx, db, plan, logDir)
	if err == nil || !strings.Contains(err.Error(), "MIGRATION_ROLLBACK_FAILED") || !strings.Contains(err.Error(), "rollback_operation=1") {
		t.Fatalf("error=%v", err)
	}
	record, found, readErr := migrationByID(ctx, db, "sqlite", plan.MigrationID)
	if readErr != nil || !found || record.Status != "rollback_failed" {
		t.Fatalf("record=%#v found=%v err=%v", record, found, readErr)
	}
}

func TestMarkRollbackFailedDoesNotOverwriteCompletedState(t *testing.T) {
	ctx, db, plan, _ := prepareSQLiteRollback(t)
	defer db.Close()
	if err := updateMigration(ctx, db, "sqlite", plan.MigrationID, "rolled_back", ""); err != nil {
		t.Fatal(err)
	}
	err := markRollbackFailed(ctx, db, "sqlite", plan.MigrationID, "late failure")
	if err == nil || !strings.Contains(err.Error(), "MIGRATION_STATE_CHANGED") {
		t.Fatalf("error=%v", err)
	}
	record, found, readErr := migrationByID(ctx, db, "sqlite", plan.MigrationID)
	if readErr != nil || !found || record.Status != "rolled_back" {
		t.Fatalf("record=%#v found=%v err=%v", record, found, readErr)
	}
}

func prepareSQLiteRollback(t *testing.T) (context.Context, *sql.DB, migrationPlanFile, string) {
	t.Helper()
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "rollback.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	base := testMigrationManifest(t, "erDiagram\n  rollback_probe {\n    bigint seq PK\n    varchar(32) name\n  }\n")
	target := testMigrationManifest(t, "erDiagram\n  rollback_probe {\n    bigint seq PK\n    varchar(32) name\n    text note \"?\"\n  }\n")
	create, err := renderCreateDDL(base, "sqlite")
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, "sqlite", create); err != nil {
		db.Close()
		t.Fatal(err)
	}
	diff, err := renderDiff(base, target, "sqlite", true)
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	plan := testMigrationPlan(base, target, "sqlite", diff)
	plan.MigrationID = "20260912-rollback"
	plan.Name = "rollback"
	if err := executeMigration(ctx, db, "sqlite", planSQL(plan.Operations)); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := ensureMigrationTable(ctx, db, "sqlite"); err != nil {
		db.Close()
		t.Fatal(err)
	}
	record := migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.FromHash, ToHash: plan.ToHash, Checksum: plan.Checksum, Status: "applied", Operations: len(plan.Operations)}
	if err := insertMigration(ctx, db, "sqlite", record); err != nil {
		db.Close()
		t.Fatal(err)
	}
	return ctx, db, plan, filepath.Join(t.TempDir(), "logs")
}
