package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/engine/schema"
	_ "modernc.org/sqlite"
)

func TestSQLiteMigrationIsIdempotentAndDetectsDrift(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "schema.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	b, err := os.ReadFile("../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	want, err := schema.Load(b)
	if err != nil {
		t.Fatal(err)
	}
	if err := ensureMigrationTable(ctx, db, "sqlite"); err != nil {
		t.Fatal(err)
	}
	live, err := liveManifest(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	ddl, err := renderCreateDDL(want, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if got := countSQLStatements(ddl); got == 0 {
		t.Fatal("initial migration has no operations")
	}
	if err := executeMigration(ctx, db, "sqlite", ddl); err != nil {
		t.Fatal(err)
	}
	live, err = liveManifest(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if !schemaMatches(want, live, "sqlite") {
		t.Fatalf("initial state does not match: want %s got %s", want.SchemaHash, live.SchemaHash)
	}
	if err := insertMigration(ctx, db, "sqlite", migrationRecord{MigrationID: "initial", Name: "initial", ToHash: want.SchemaHash, Status: "applied"}); err != nil {
		t.Fatal(err)
	}
	rec, ok, err := appliedMigration(ctx, db, "sqlite", "initial")
	if err != nil || !ok || rec.Status != "applied" {
		t.Fatalf("history = %#v, %v, %v", rec, ok, err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE "battle" ADD COLUMN "external_drift" TEXT`); err != nil {
		t.Fatal(err)
	}
	live, err = liveManifest(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if schemaMatches(want, live, "sqlite") {
		t.Fatal("external schema change was not detected")
	}
}

func TestLiveManifestAllowsAddingAESVersionColumn(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "aes-upgrade.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE account (seq INTEGER PRIMARY KEY, aes_hex_email varchar(255) NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	live, err := liveManifest(db, "sqlite")
	if err != nil {
		t.Fatalf("read transitional live schema: %v", err)
	}
	diagram, err := schema.Parse("erDiagram\n  account {\n    integer seq PK\n    varchar(255) aes_hex_email\n    integer aes_key_version \"=1\"\n  }\n")
	if err != nil {
		t.Fatal(err)
	}
	target, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := renderDiff(live, target, "sqlite", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan, `ADD COLUMN "aes_key_version" INTEGER NOT NULL DEFAULT 1`) {
		t.Fatalf("AES version migration missing: %s", plan)
	}
}

func TestMigrationLogUsesTimestampAndDetectsRecordMismatch(t *testing.T) {
	dir := t.TempDir()
	started := time.Date(2026, 9, 12, 13, 30, 0, 123456789, time.UTC)
	record := migrationRecord{MigrationID: "20260912-initial", Name: "initial", FromHash: "from", ToHash: "to", Checksum: "plan", Status: "applied", Operations: 3}
	log := migrationLogFromRecord(record, "sqlite", started, started.Add(time.Second))
	if err := writeMigrationLog(dir, log); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !strings.Contains(entries[0].Name(), "20260912T133000.123456789Z__20260912-initial.json") {
		t.Fatalf("unexpected log filename: %#v", entries)
	}
	if err := verifyMigrationLog(dir, record, "sqlite"); err != nil {
		t.Fatal(err)
	}
	record.Checksum = "different"
	if err := verifyMigrationLog(dir, record, "sqlite"); err == nil || !strings.Contains(err.Error(), "MIGRATION_LOG_CONFLICT") {
		t.Fatalf("expected log conflict, got %v", err)
	}
}

func TestCommentDDLAndDiff(t *testing.T) {
	oldText := "erDiagram\n  account {\n    bigint seq PK\n    varchar(64) email\n  }\n  %% table_comment account \"old table\"\n  %% column_comment account email \"old email\"\n"
	newText := strings.ReplaceAll(strings.ReplaceAll(oldText, "old table", "new table"), "old email", "new email")
	oldD, err := schema.Parse(oldText)
	if err != nil {
		t.Fatal(err)
	}
	newD, err := schema.Parse(newText)
	if err != nil {
		t.Fatal(err)
	}
	oldM, err := schema.Build(oldD)
	if err != nil {
		t.Fatal(err)
	}
	newM, err := schema.Build(newD)
	if err != nil {
		t.Fatal(err)
	}
	sqlText, err := renderDiff(oldM, newM, "sqlite", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sqlText, "orm_schema_comments") || !strings.Contains(sqlText, "new table") || !strings.Contains(sqlText, "new email") {
		t.Fatalf("comment diff = %s", sqlText)
	}
	ddl, err := renderCreateDDL(newM, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ddl, "CREATE TABLE IF NOT EXISTS orm_schema_comments") || !strings.Contains(ddl, "new email") {
		t.Fatalf("comment ddl = %s", ddl)
	}
}

func TestSplitSQLPreservesQuotedSemicolons(t *testing.T) {
	got := splitSQL("INSERT INTO x VALUES ('a;b'); -- comment ;\nDO $$ BEGIN PERFORM 'c;d'; END $$; SELECT `e;f`; /* ; */ SELECT 1;")
	if len(got) != 4 {
		t.Fatalf("statements = %#v", got)
	}
	if !strings.Contains(got[0], "a;b") || !strings.Contains(got[1], "c;d") || !strings.Contains(got[2], "e;f") {
		t.Fatalf("quoted content lost: %#v", got)
	}
}

func TestExecuteMigrationRollsBackSQLiteOnStatementFailure(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	err = executeMigration(context.Background(), db, "sqlite", "CREATE TABLE first (id INTEGER); CREATE TABLE broken (id INTEGER;)")
	if err == nil || !strings.Contains(err.Error(), "rollback issued") || !strings.Contains(err.Error(), "operation=2") {
		t.Fatalf("error = %v", err)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='first'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("failed migration left first table behind")
	}
}

func TestExecuteMigrationRejectsConcurrentSQLiteWriter(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "locked.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	holder, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	if _, err := holder.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	defer holder.ExecContext(context.Background(), "ROLLBACK")
	err = executeMigration(context.Background(), db, "sqlite", "CREATE TABLE blocked (id INTEGER);")
	if err == nil || !strings.Contains(err.Error(), "MIGRATION_LOCK_BUSY") {
		t.Fatalf("expected SQLite lock error, got %v", err)
	}
}

func TestRecoverMigrationMarksSourceRetryableAndTargetApplied(t *testing.T) {
	ctx := context.Background()
	base := testMigrationManifest(t, "erDiagram\n  recovery_probe {\n    bigint seq PK\n    varchar(32) name\n  }\n")
	target := testMigrationManifest(t, "erDiagram\n  recovery_probe {\n    bigint seq PK\n    varchar(32) name\n    text note \"?\"\n  }\n")
	for _, tc := range []struct {
		name       string
		applyPlan  bool
		wantStatus string
	}{
		{name: "source", wantStatus: "retryable"},
		{name: "target", applyPlan: true, wantStatus: "applied"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "recover.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			ddl, err := renderCreateDDL(base, "sqlite")
			if err != nil {
				t.Fatal(err)
			}
			if err := executeMigration(ctx, db, "sqlite", ddl); err != nil {
				t.Fatal(err)
			}
			diff, err := renderDiff(base, target, "sqlite", false)
			if err != nil {
				t.Fatal(err)
			}
			plan := testMigrationPlan(base, target, "sqlite", diff)
			if err := ensureMigrationTable(ctx, db, "sqlite"); err != nil {
				t.Fatal(err)
			}
			record := migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.FromHash, ToHash: plan.ToHash, Checksum: plan.Checksum, Status: "failed", Operations: len(plan.Operations)}
			if err := insertMigration(ctx, db, "sqlite", record); err != nil {
				t.Fatal(err)
			}
			if tc.applyPlan {
				if err := executeMigration(ctx, db, "sqlite", planSQL(plan.Operations)); err != nil {
					t.Fatal(err)
				}
			}
			logDir := filepath.Join(t.TempDir(), "logs")
			status, err := recoverMigration(ctx, db, "sqlite", plan, target, logDir)
			if err != nil {
				t.Fatal(err)
			}
			if status != tc.wantStatus {
				t.Fatalf("status=%s want=%s", status, tc.wantStatus)
			}
			got, found, err := migrationByID(ctx, db, "sqlite", plan.MigrationID)
			if err != nil || !found || got.Status != tc.wantStatus {
				t.Fatalf("record=%#v found=%v err=%v", got, found, err)
			}
			if err := verifyMigrationLog(logDir, got, "sqlite"); err != nil {
				t.Fatal(err)
			}
			status, err = recoverMigration(ctx, db, "sqlite", plan, target, logDir)
			if err != nil || status != "noop" {
				t.Fatalf("repeat status=%s err=%v", status, err)
			}
		})
	}
}

func TestRecoverMigrationRejectsPartialSchemaWithoutMutation(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "unsafe.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	base := testMigrationManifest(t, "erDiagram\n  recovery_probe {\n    bigint seq PK\n  }\n")
	target := testMigrationManifest(t, "erDiagram\n  recovery_probe {\n    bigint seq PK\n    text note \"?\"\n  }\n")
	ddl, err := renderCreateDDL(base, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, "sqlite", ddl+"ALTER TABLE recovery_probe ADD COLUMN external_drift TEXT;"); err != nil {
		t.Fatal(err)
	}
	diff, err := renderDiff(base, target, "sqlite", false)
	if err != nil {
		t.Fatal(err)
	}
	plan := testMigrationPlan(base, target, "sqlite", diff)
	if err := ensureMigrationTable(ctx, db, "sqlite"); err != nil {
		t.Fatal(err)
	}
	record := migrationRecord{MigrationID: plan.MigrationID, Name: plan.Name, FromHash: plan.FromHash, ToHash: plan.ToHash, Checksum: plan.Checksum, Status: "failed", Operations: len(plan.Operations)}
	if err := insertMigration(ctx, db, "sqlite", record); err != nil {
		t.Fatal(err)
	}
	logDir := filepath.Join(t.TempDir(), "logs")
	_, err = recoverMigration(ctx, db, "sqlite", plan, target, logDir)
	if err == nil || !strings.Contains(err.Error(), "MIGRATION_RECOVERY_UNSAFE") || !strings.Contains(err.Error(), "database and file logs were not modified") {
		t.Fatalf("error=%v", err)
	}
	got, found, readErr := migrationByID(ctx, db, "sqlite", plan.MigrationID)
	if readErr != nil || !found || got.Status != "failed" {
		t.Fatalf("record=%#v found=%v err=%v", got, found, readErr)
	}
	entries, readErr := os.ReadDir(logDir)
	if !os.IsNotExist(readErr) || len(entries) != 0 {
		t.Fatalf("unexpected logs=%v err=%v", entries, readErr)
	}
}

func TestRecoverMigrationByIDUsesRecordedSourceAndTarget(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "recover-id.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	base := testMigrationManifest(t, "erDiagram\n  recovery_id_probe {\n    bigint seq PK\n  }\n")
	target := testMigrationManifest(t, "erDiagram\n  recovery_id_probe {\n    bigint seq PK\n    text note \"?\"\n  }\n")
	ddl, err := renderCreateDDL(base, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, "sqlite", ddl); err != nil {
		t.Fatal(err)
	}
	live, err := liveManifest(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	diff, err := renderDiff(base, target, "sqlite", false)
	if err != nil {
		t.Fatal(err)
	}
	record := migrationRecord{MigrationID: "20260912-recovery-id", Name: "recovery by id", FromHash: live.SchemaHash, ToHash: target.SchemaHash, Checksum: checksumText(diff), Status: "failed", Operations: countSQLStatements(diff)}
	if err := ensureMigrationTable(ctx, db, "sqlite"); err != nil {
		t.Fatal(err)
	}
	if err := insertMigration(ctx, db, "sqlite", record); err != nil {
		t.Fatal(err)
	}
	logDir := t.TempDir()
	status, err := recoverMigrationByID(ctx, db, "sqlite", record.MigrationID, target, logDir)
	if err != nil || status != "retryable" {
		t.Fatalf("source status=%s err=%v", status, err)
	}
	if err := executeClaimedMigration(ctx, db, "sqlite", record.MigrationID, "retryable", diff); err != nil {
		t.Fatal(err)
	}
	status, err = recoverMigrationByID(ctx, db, "sqlite", record.MigrationID, target, logDir)
	if err != nil || status != "applied" {
		t.Fatalf("target status=%s err=%v", status, err)
	}
	status, err = recoverMigrationByID(ctx, db, "sqlite", record.MigrationID, target, logDir)
	if err != nil || status != "noop" {
		t.Fatalf("repeat status=%s err=%v", status, err)
	}
}

func TestExecuteClaimedMigrationRequiresExpectedState(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "claim.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := ensureMigrationTable(ctx, db, "sqlite"); err != nil {
		t.Fatal(err)
	}
	record := migrationRecord{MigrationID: "claim", Name: "claim", Status: "retryable"}
	if err := insertMigration(ctx, db, "sqlite", record); err != nil {
		t.Fatal(err)
	}
	err = executeClaimedMigration(ctx, db, "sqlite", record.MigrationID, "queued", "CREATE TABLE must_not_exist (id INTEGER);")
	if err == nil || !strings.Contains(err.Error(), "MIGRATION_STATE_CHANGED") {
		t.Fatalf("error=%v", err)
	}
	var count int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='must_not_exist'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("SQL executed after migration claim failure")
	}
}

func TestMigrateCommandRepeatsAsNoop(t *testing.T) {
	dir := t.TempDir()
	manifest := testMigrationManifest(t, "erDiagram\n  command_probe {\n    bigint seq PK\n    varchar(32) name\n  }\n")
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	schemaPath := filepath.Join(dir, "schema.json")
	if err := os.WriteFile(schemaPath, manifestJSON, 0o644); err != nil {
		t.Fatal(err)
	}
	args := []string{"--driver", "sqlite", "--dsn", filepath.Join(dir, "command.sqlite"), "--schema", schemaPath, "--migration-id", "20260912-command", "--log-dir", filepath.Join(dir, "logs")}
	first := runMigrationCommand(t, args)
	if !strings.Contains(first, "status=applied") {
		t.Fatalf("first output=%s", first)
	}
	second := runMigrationCommand(t, args)
	if !strings.Contains(second, "status=noop operations=0") {
		t.Fatalf("repeat output=%s", second)
	}
}

func TestMigrationCommandHelper(t *testing.T) {
	raw := os.Getenv("ORM_TEST_MIGRATE_ARGS")
	if raw == "" {
		return
	}
	var args []string
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		t.Fatal(err)
	}
	migrateCmd(args)
}

func runMigrationCommand(t *testing.T, args []string) string {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestMigrationCommandHelper$")
	cmd.Env = append(os.Environ(), "ORM_TEST_MIGRATE_ARGS="+string(raw))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("migrate command: %v\n%s", err, out)
	}
	return string(out)
}

func testMigrationManifest(t *testing.T, source string) *schema.Manifest {
	t.Helper()
	diagram, err := schema.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	return manifest
}

func testMigrationPlan(from, to *schema.Manifest, driver, sqlText string) migrationPlanFile {
	plan := migrationPlanFile{Version: 1, MigrationID: "20260912-recovery", Name: "recovery", Driver: driver, FromHash: from.SchemaHash, FromSchema: from, ToHash: to.SchemaHash, ToSchema: to}
	plan.Operations = planOperations(sqlText)
	plan.Checksum = checksumText(planSQL(plan.Operations))
	rollbackText, err := renderDiff(to, from, driver, true)
	if err != nil {
		panic(err)
	}
	plan.RollbackOperations = planOperations(rollbackText)
	plan.RollbackChecksum = checksumText(planSQL(plan.RollbackOperations))
	plan.RollbackDataLossRisk = hasDestructive(plan.Operations) || hasDestructive(plan.RollbackOperations)
	return plan
}
