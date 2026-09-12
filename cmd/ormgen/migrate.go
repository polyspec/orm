package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
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

type migrationRecord struct {
	MigrationID string
	Name        string
	FromHash    string
	ToHash      string
	Checksum    string
	Status      string
	Operations  int
}

func migrateCmd(args []string) {
	fs := flag.NewFlagSet("migrate", flag.ExitOnError)
	dsn := fs.String("dsn", "", "database DSN or SQLite path (required)")
	driver := fs.String("driver", "mysql", "mysql|postgres|sqlite")
	schemaPath := fs.String("schema", "", "target schema.json (required)")
	id := fs.String("migration-id", "initial", "stable migration identifier")
	name := fs.String("name", "schema sync", "migration name")
	dryRun := fs.Bool("dry-run", false, "show the plan without changing the database")
	fs.Parse(args)
	if *dsn == "" || *schemaPath == "" {
		fail(fmt.Errorf("MIGRATION_CONFIG: --dsn and --schema are required"))
	}
	if *driver != "mysql" && *driver != "postgres" && *driver != "sqlite" {
		fail(fmt.Errorf("MIGRATION_CONFIG: unsupported driver %q", *driver))
	}
	b, err := os.ReadFile(*schemaPath)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: read %s: %w", *schemaPath, err))
	}
	want, err := schema.Load(b)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_SOURCE: %w", err))
	}
	driverName, openDSN := sqlDriver(*driver, *dsn)
	db, err := sql.Open(driverName, openDSN)
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
	if _, ok, err := appliedMigration(ctx, db, *driver, *id); err != nil {
		fail(err)
	} else if ok {
		live, err := liveManifest(db, *driver)
		if err != nil {
			fail(fmt.Errorf("MIGRATION_INTROSPECT: %w", err))
		}
		if !schemaMatches(want, live, *driver) {
			fail(fmt.Errorf("MIGRATION_DRIFT: migration_id=%s expected_schema_hash=%s actual_schema_hash=%s", *id, want.SchemaHash, live.SchemaHash))
		}
		fmt.Printf("migration_id=%s status=noop operations=0 schema_hash=%s\n", *id, want.SchemaHash)
		return
	}

	live, err := liveManifest(db, *driver)
	if err != nil {
		fail(fmt.Errorf("MIGRATION_INTROSPECT: driver=%s: %w", *driver, err))
	}
	var sqlText string
	if len(live.Entities) == 0 {
		sqlText, err = renderCreateDDL(want, *driver)
	} else {
		sqlText, err = renderDiff(live, want, *driver, false)
	}
	if err != nil {
		fail(fmt.Errorf("MIGRATION_PLAN: from=%s to=%s: %w", live.SchemaHash, want.SchemaHash, err))
	}
	operations := countSQLStatements(sqlText)
	if *dryRun {
		fmt.Printf("migration_id=%s status=planned from_schema_hash=%s to_schema_hash=%s operations=%d\n%s", *id, live.SchemaHash, want.SchemaHash, operations, sqlText)
		return
	}

	checksum := checksumText(sqlText)
	if err := insertMigration(ctx, db, *driver, migrationRecord{MigrationID: *id, Name: *name, FromHash: live.SchemaHash, ToHash: want.SchemaHash, Checksum: checksum, Status: "applying", Operations: operations}); err != nil {
		fail(err)
	}
	if err := executeMigration(ctx, db, sqlText); err != nil {
		detail := fmt.Sprintf("operation execution failed: %v", err)
		_ = updateMigration(ctx, db, *driver, *id, "failed", detail)
		fail(fmt.Errorf("MIGRATION_APPLY_FAILED: migration_id=%s from=%s to=%s: %w", *id, live.SchemaHash, want.SchemaHash, err))
	}
	check, err := liveManifest(db, *driver)
	if err != nil {
		_ = updateMigration(ctx, db, *driver, *id, "failed", err.Error())
		fail(fmt.Errorf("MIGRATION_VERIFY_FAILED: migration_id=%s: %w", *id, err))
	}
	if !schemaMatches(want, check, *driver) {
		detail := fmt.Sprintf("expected %s got %s", want.SchemaHash, check.SchemaHash)
		_ = updateMigration(ctx, db, *driver, *id, "failed", detail)
		fail(fmt.Errorf("MIGRATION_VERIFY_FAILED: migration_id=%s %s", *id, detail))
	}
	if err := updateMigration(ctx, db, *driver, *id, "applied", ""); err != nil {
		fail(fmt.Errorf("MIGRATION_HISTORY_WRITE: migration_id=%s: %w", *id, err))
	}
	fmt.Printf("migration_id=%s status=applied from_schema_hash=%s to_schema_hash=%s operations=%d\n", *id, live.SchemaHash, want.SchemaHash, operations)
}

func sqlDriver(driver, dsn string) (string, string) {
	if driver == "postgres" {
		return "pgx", dsn
	}
	if driver == "sqlite" {
		return "sqlite", dsn
	}
	return "mysql", dsn
}

func redactDSN(s string) string {
	if i := strings.IndexByte(s, '@'); i >= 0 && strings.Contains(s[:i], ":") {
		return "***@" + s[i+1:]
	}
	return s
}

func emptyManifest() *schema.Manifest { return &schema.Manifest{Entities: map[string]*schema.Entity{}} }

func liveManifest(db *sql.DB, driver string) (*schema.Manifest, error) {
	var tables []impTable
	var err error
	switch driver {
	case "sqlite":
		tables, err = readTablesSQLite(db)
	default:
		tables, err = readTables(db, driver, nil)
	}
	if err != nil {
		return nil, err
	}
	if len(tables) == 0 {
		return emptyManifest(), nil
	}
	d, err := schema.Parse(renderMermaid(tables, nil))
	if err != nil {
		return nil, err
	}
	return schema.Build(d)
}

func readTablesSQLite(db *sql.DB) ([]impTable, error) {
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'orm_schema_migrations' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []impTable
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		t := impTable{Name: name}
		qname := strings.ReplaceAll(name, "'", "''")
		cols, err := db.Query("PRAGMA table_info('" + qname + "')")
		if err != nil {
			return nil, fmt.Errorf("table %s columns: %w", name, err)
		}
		for cols.Next() {
			var cid, notnull, pk int
			var c impColumn
			var def sql.NullString
			if err := cols.Scan(&cid, &c.Name, &c.Type, &notnull, &def, &pk); err != nil {
				cols.Close()
				return nil, err
			}
			c.Nullable = notnull == 0 && pk == 0
			if def.Valid {
				c.Default = def.String
			} else {
				c.Default = "\x00"
			}
			if pk > 0 {
				c.Key = "PRI"
			}
			t.Columns = append(t.Columns, c)
		}
		if err := cols.Close(); err != nil {
			return nil, err
		}
		idx, err := db.Query("PRAGMA index_list('" + qname + "')")
		if err != nil {
			return nil, err
		}
		for idx.Next() {
			var seq int
			var indexName, origin string
			var unique, partial int
			if err := idx.Scan(&seq, &indexName, &unique, &origin, &partial); err != nil {
				idx.Close()
				return nil, err
			}
			if origin == "pk" {
				continue
			}
			icols, err := db.Query("PRAGMA index_info('" + strings.ReplaceAll(indexName, "'", "''") + "')")
			if err != nil {
				idx.Close()
				return nil, err
			}
			ix := impIndex{Name: indexName, Unique: unique != 0}
			for icols.Next() {
				var seq, cid int
				var col string
				if err := icols.Scan(&seq, &cid, &col); err != nil {
					icols.Close()
					idx.Close()
					return nil, err
				}
				ix.Columns = append(ix.Columns, col)
			}
			icols.Close()
			if len(ix.Columns) > 0 {
				t.Indexes = append(t.Indexes, ix)
			}
		}
		if err := idx.Close(); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func ensureMigrationTable(ctx context.Context, db *sql.DB, driver string) error {
	var q string
	switch driver {
	case "mysql":
		q = "CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL, from_schema_hash varchar(128) NOT NULL, to_schema_hash varchar(128) NOT NULL, plan_checksum varchar(128) NOT NULL, status varchar(32) NOT NULL, operations int NOT NULL, error_detail text NOT NULL, started_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamp NULL)"
	case "postgres":
		q = "CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz NULL)"
	default:
		q = "CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT NULL)"
	}
	if _, err := db.ExecContext(ctx, q); err != nil {
		return fmt.Errorf("MIGRATION_HISTORY_CREATE: driver=%s: %w", driver, err)
	}
	return nil
}

func appliedMigration(ctx context.Context, db *sql.DB, driver, id string) (migrationRecord, bool, error) {
	q := "SELECT migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations FROM orm_schema_migrations WHERE migration_id=" + placeholder(driver, 1)
	var r migrationRecord
	err := db.QueryRowContext(ctx, q, id).Scan(&r.MigrationID, &r.Name, &r.FromHash, &r.ToHash, &r.Checksum, &r.Status, &r.Operations)
	if errors.Is(err, sql.ErrNoRows) {
		return r, false, nil
	}
	if err != nil {
		return r, false, fmt.Errorf("MIGRATION_HISTORY_READ: migration_id=%s: %w", id, err)
	}
	if r.Status != "applied" {
		return r, false, fmt.Errorf("MIGRATION_PARTIAL: migration_id=%s status=%s", id, r.Status)
	}
	return r, true, nil
}

func insertMigration(ctx context.Context, db *sql.DB, driver string, r migrationRecord) error {
	args := []any{r.MigrationID, r.Name, r.FromHash, r.ToHash, r.Checksum, r.Status, r.Operations}
	ph := make([]string, len(args))
	for i := range ph {
		ph[i] = placeholder(driver, i+1)
	}
	q := "INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail) VALUES (" + strings.Join(ph, ",") + ", '')"
	if _, err := db.ExecContext(ctx, q, args...); err != nil {
		return fmt.Errorf("MIGRATION_HISTORY_WRITE: migration_id=%s: %w", r.MigrationID, err)
	}
	return nil
}

func updateMigration(ctx context.Context, db *sql.DB, driver, id, status, detail string) error {
	q := "UPDATE orm_schema_migrations SET status=" + placeholder(driver, 1) + ", error_detail=" + placeholder(driver, 2) + ", finished_at=CURRENT_TIMESTAMP WHERE migration_id=" + placeholder(driver, 3)
	_, err := db.ExecContext(ctx, q, status, detail, id)
	return err
}

func placeholder(driver string, n int) string {
	if driver == "postgres" {
		return fmt.Sprintf("$%d", n)
	}
	return "?"
}

func executeMigration(ctx context.Context, db *sql.DB, text string) error {
	for i, stmt := range splitSQL(text) {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("operation=%d statement=%q: %w", i+1, stmt, err)
		}
	}
	return nil
}

func splitSQL(text string) []string {
	var out []string
	for _, s := range strings.Split(text, ";") {
		s = strings.TrimSpace(s)
		for strings.HasPrefix(s, "--") {
			if i := strings.IndexByte(s, '\n'); i >= 0 {
				s = strings.TrimSpace(s[i+1:])
			} else {
				s = ""
			}
		}
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func countSQLStatements(text string) int { return len(splitSQL(text)) }

func checksumText(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func schemaMatches(want, live *schema.Manifest, driver string) bool {
	if driver != "sqlite" {
		return want.SchemaHash == live.SchemaHash
	}
	if len(want.Entities) != len(live.Entities) {
		return false
	}
	for name, we := range want.Entities {
		le := live.Entities[name]
		if le == nil || we.Table != le.Table || len(we.Columns) != len(le.Columns) {
			return false
		}
		for i, wc := range we.Columns {
			lc := le.Columns[i]
			if wc.Name != lc.Name || wc.Nullable != lc.Nullable || !sqliteTypeMatches(wc.Type, lc.Type) {
				return false
			}
		}
	}
	return true
}

func sqliteTypeMatches(want, live string) bool {
	if want == live {
		return true
	}
	switch live {
	case "i32":
		return want == "i32" || want == "i64" || want == "bool"
	case "f64":
		return want == "f64" || want == "decimal"
	case "text":
		return want == "string" || want == "text" || want == "json" || want == "datetime" || want == "date" || want == "time" || want == "enum"
	case "bytes":
		return want == "bytes" || want == "inet"
	default:
		return false
	}
}
