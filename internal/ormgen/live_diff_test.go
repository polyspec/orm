package ormgen

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
	_ "modernc.org/sqlite"
)

const liveDiffBase = "er" + "Diagram\n" +
	"  live_article {\n" +
	"    bigint       seq         PK \"auto\"\n" +
	"    varchar(191) title\n" +
	"    text         body           \"?\"\n" +
	"    int          quantity       \"=0\"\n" +
	"    datetime(6)  created_ts     \"=now\"\n" +
	"    datetime(6)  updated_ts     \"=now onupdate\"\n" +
	"  }\n" +
	"  %% fulltext live_article (title, body)\n" +
	"  %% check live_article live_article_quantity : `quantity` >= 0 AND `quantity` IN (0, 1, 2, 5)\n" +
	"  %% column_comment live_article title \"headline\"\n"

// liveDiffTarget declares a new commented column in the middle of the table.
var liveDiffTarget = strings.Replace(liveDiffBase, "    text         body", "    varchar(32)  subtitle       \"?\"\n    text         body", 1) +
	"  %% column_comment live_article subtitle \"secondary headline\"\n"

func TestSQLiteLiveIncrementalMigration(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "live.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	assertLiveIncrementalMigration(t, context.Background(), db, "sqlite")
}

// assertLiveIncrementalMigration creates a table with an automatic key, clock
// defaults, an update-time column, a full-text index, a CHECK constraint, and
// comments; compares it with its declaration; adds a commented column in the
// middle of the declaration; and removes it again.
func assertLiveIncrementalMigration(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	quote := `"`
	if driver == "mysql" {
		quote = "`"
	}
	drop := func() {
		_, _ = db.ExecContext(context.Background(), "DROP TABLE IF EXISTS "+quote+"live_article"+quote)
	}
	drop()
	t.Cleanup(drop)
	base := buildLiveDiffManifest(t, liveDiffBase)
	target := buildLiveDiffManifest(t, liveDiffTarget)
	ddl, err := renderCreateDDL(base, driver)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, ddl); err != nil {
		t.Fatalf("create: %v\n%s", err, ddl)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO "+quote+"live_article"+quote+" ("+quote+"title"+quote+", "+quote+"quantity"+quote+") VALUES ('kept', 2)"); err != nil {
		t.Fatal(err)
	}
	live := liveDiffState(t, ctx, db, driver, base)
	if !schemaMatches(base, live, driver) {
		t.Fatalf("created schema does not match: %s", manifestMismatch(base, live, driver))
	}
	unchanged, err := renderDiff(live, base, driver, false)
	if err != nil {
		t.Fatalf("diff against the declaration: %v", err)
	}
	if !strings.Contains(unchanged, "-- no changes") {
		t.Fatalf("unchanged table has a diff:\n%s", unchanged)
	}
	forward, err := renderDiff(live, target, driver, false)
	if err != nil {
		t.Fatalf("add column: %v", err)
	}
	if strings.Contains(forward, "__orm_rebuild_") {
		t.Fatalf("adding a nullable column rebuilds the table:\n%s", forward)
	}
	if err := executeMigration(ctx, db, driver, forward); err != nil {
		t.Fatalf("apply add column: %v\n%s", err, forward)
	}
	live = liveDiffState(t, ctx, db, driver, target)
	if !schemaMatches(target, live, driver) {
		t.Fatalf("added column does not verify: %s", manifestMismatch(target, live, driver))
	}
	repeat, err := renderDiff(live, target, driver, false)
	if err != nil || !strings.Contains(repeat, "-- no changes") {
		t.Fatalf("repeat after add column: %v\n%s", err, repeat)
	}
	backward, err := renderDiff(live, base, driver, true)
	if err != nil {
		t.Fatalf("remove column: %v", err)
	}
	if err := executeMigration(ctx, db, driver, backward); err != nil {
		t.Fatalf("apply remove column: %v\n%s", err, backward)
	}
	live = liveDiffState(t, ctx, db, driver, base)
	if !schemaMatches(base, live, driver) {
		t.Fatalf("removed column does not verify: %s", manifestMismatch(base, live, driver))
	}
	final, err := renderDiff(live, base, driver, false)
	if err != nil || !strings.Contains(final, "-- no changes") {
		t.Fatalf("repeat after remove column: %v\n%s", err, final)
	}
	var title string
	var quantity int
	if err := db.QueryRowContext(ctx, "SELECT "+quote+"title"+quote+", "+quote+"quantity"+quote+" FROM "+quote+"live_article"+quote).Scan(&title, &quantity); err != nil || title != "kept" || quantity != 2 {
		t.Fatalf("row title=%q quantity=%d err=%v", title, quantity, err)
	}
}

func liveDiffState(t *testing.T, ctx context.Context, db *sql.DB, driver string, want *schema.Manifest) *schema.Manifest {
	t.Helper()
	all, err := liveManifest(db, driver)
	if err != nil {
		t.Fatal(err)
	}
	article := all.Entities["live_article"]
	if article == nil {
		t.Fatal("live_article is missing from the database")
	}
	live := &schema.Manifest{SchemaHash: all.SchemaHash, Order: []string{"live_article"}, Entities: map[string]*schema.Entity{"live_article": article}}
	if err := alignLiveChecks(ctx, db, driver, live, want); err != nil {
		t.Fatal(err)
	}
	return live
}

func buildLiveDiffManifest(t *testing.T, source string) *schema.Manifest {
	t.Helper()
	d, err := schema.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// manifestMismatch names the first difference schemaMatches reports.
func manifestMismatch(want, live *schema.Manifest, driver string) string {
	for name, we := range want.Entities {
		le := live.Entities[name]
		if le == nil {
			return fmt.Sprintf("missing table %s", name)
		}
		if we.Table != le.Table || we.Comment != le.Comment {
			return fmt.Sprintf("entity %s table=%s comment=%q, got table=%s comment=%q", name, we.Table, we.Comment, le.Table, le.Comment)
		}
		for _, wc := range we.Columns {
			lc := le.Column(wc.Name)
			if lc == nil {
				return fmt.Sprintf("missing column %s.%s", name, wc.Name)
			}
			typeMatch := wc.Type == lc.Type || driver == "sqlite" && sqliteTypeMatches(wc.Type, lc.Type)
			if !typeMatch || wc.Nullable != lc.Nullable || wc.Comment != lc.Comment {
				return fmt.Sprintf("column %s.%s type=%s nullable=%t comment=%q, got type=%s nullable=%t comment=%q", name, wc.Name, wc.Type, wc.Nullable, wc.Comment, lc.Type, lc.Nullable, lc.Comment)
			}
		}
		for _, lc := range le.Columns {
			if we.Column(lc.Name) == nil {
				return fmt.Sprintf("extra column %s.%s", name, lc.Name)
			}
		}
	}
	for name := range live.Entities {
		if want.Entities[name] == nil {
			return fmt.Sprintf("extra table %s", name)
		}
	}
	return "manifest fields differ"
}

func TestSQLiteLiveSourcePlan(t *testing.T) {
	path := filepath.Join(t.TempDir(), "plan.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	assertLiveSourcePlan(t, context.Background(), db, "sqlite", "sqlite://"+path)
}

// assertLiveSourcePlan writes a plan from a db: source whose CHECK text is
// aligned with the declaration; the plan's embedded source schema must match
// its hash so apply and rollback accept it.
func assertLiveSourcePlan(t *testing.T, ctx context.Context, db *sql.DB, driver, dsn string) {
	t.Helper()
	quote := `"`
	if driver == "mysql" {
		quote = "`"
	}
	drop := func() {
		_, _ = db.ExecContext(context.Background(), "DROP TABLE IF EXISTS "+quote+"live_article"+quote)
	}
	drop()
	t.Cleanup(drop)
	base := buildLiveDiffManifest(t, liveDiffBase)
	ddl, err := renderCreateDDL(base, driver)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, ddl); err != nil {
		t.Fatalf("create: %v\n%s", err, ddl)
	}
	target := filepath.Join(t.TempDir(), "target.mmd")
	if err := os.WriteFile(target, []byte(liveDiffTarget), 0o644); err != nil {
		t.Fatal(err)
	}
	source := "db:" + dsn
	from, err := loadSchemaSource(source, driver)
	if err != nil {
		t.Fatal(err)
	}
	to, err := loadSchemaSource(target, driver)
	if err != nil {
		t.Fatal(err)
	}
	before := from.SchemaHash
	if err := alignSourceChecks(source, target, from, to); err != nil {
		t.Fatal(err)
	}
	article := from.Entities["live_article"]
	if article == nil || len(article.Checks) != 1 || article.Checks[0].Expr != to.Entities["live_article"].Checks[0].Expr {
		t.Fatalf("live check was not aligned: %#v", article)
	}
	if from.SchemaHash == before {
		t.Fatal("aligned source kept its previous schema hash")
	}
	b, err := buildMigrationPlan(from, to, driver, "20260917-live-source", "live source")
	if err != nil {
		t.Fatal(err)
	}
	var plan migrationPlanFile
	if err := json.Unmarshal(b, &plan); err != nil {
		t.Fatal(err)
	}
	if err := validateRollbackPlan(plan); err != nil {
		t.Fatalf("plan from a db: source is rejected: %v", err)
	}
}
