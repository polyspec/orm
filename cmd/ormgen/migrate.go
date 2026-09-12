package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
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

type migrationLog struct {
	MigrationID string `json:"migration_id"`
	Name        string `json:"name"`
	Driver      string `json:"driver"`
	FromHash    string `json:"from_schema_hash"`
	ToHash      string `json:"to_schema_hash"`
	Checksum    string `json:"plan_checksum"`
	Status      string `json:"status"`
	Operations  int    `json:"operations"`
	ErrorDetail string `json:"error_detail,omitempty"`
	StartedAt   string `json:"started_at"`
	FinishedAt  string `json:"finished_at,omitempty"`
}

func (l migrationLog) withError(detail string) migrationLog {
	l.ErrorDetail = detail
	return l
}

func migrateCmd(args []string) {
	fs := flag.NewFlagSet("migrate", flag.ExitOnError)
	dsn := fs.String("dsn", "", "database DSN or SQLite path (required)")
	driver := fs.String("driver", "mysql", "mysql|postgres|sqlite")
	schemaPath := fs.String("schema", "", "target schema.json (required)")
	id := fs.String("migration-id", "initial", "stable migration identifier")
	name := fs.String("name", "schema sync", "migration name")
	logDir := fs.String("log-dir", "migrations/logs", "directory for migration JSON logs")
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
	checksum := checksumText(sqlText)
	previous, found, err := appliedMigration(ctx, db, *driver, *id)
	if err != nil {
		fail(err)
	}
	if found {
		if previous.ToHash != want.SchemaHash || previous.FromHash != live.SchemaHash || previous.Checksum != checksum {
			fail(fmt.Errorf("MIGRATION_HISTORY_CONFLICT: migration_id=%s recorded_from=%s requested_from=%s recorded_to=%s requested_to=%s recorded_plan_checksum=%s requested_plan_checksum=%s", *id, previous.FromHash, live.SchemaHash, previous.ToHash, want.SchemaHash, previous.Checksum, checksum))
		}
		if !schemaMatches(want, live, *driver) {
			fail(fmt.Errorf("MIGRATION_DRIFT: migration_id=%s expected_schema_hash=%s actual_schema_hash=%s", *id, want.SchemaHash, live.SchemaHash))
		}
		if err := verifyMigrationLog(*logDir, previous, *driver); err != nil {
			fail(err)
		}
		fmt.Printf("migration_id=%s status=noop operations=0 schema_hash=%s\n", *id, want.SchemaHash)
		return
	}
	if *dryRun {
		fmt.Printf("migration_id=%s status=planned from_schema_hash=%s to_schema_hash=%s operations=%d\n%s", *id, live.SchemaHash, want.SchemaHash, operations, sqlText)
		return
	}

	record := migrationRecord{MigrationID: *id, Name: *name, FromHash: live.SchemaHash, ToHash: want.SchemaHash, Checksum: checksum, Status: "applying", Operations: operations}
	startedAt := time.Now().UTC()
	if err := writeMigrationLog(*logDir, migrationLogFromRecord(record, *driver, startedAt, time.Time{})); err != nil {
		fail(err)
	}
	if err := insertMigration(ctx, db, *driver, record); err != nil {
		_ = writeMigrationLog(*logDir, migrationLogFromRecord(record, *driver, startedAt, time.Now().UTC()).withError(err.Error()))
		fail(err)
	}
	if err := executeMigration(ctx, db, *driver, sqlText); err != nil {
		detail := fmt.Sprintf("operation execution failed: %v", err)
		_ = updateMigration(ctx, db, *driver, *id, "failed", detail)
		_ = writeMigrationLog(*logDir, migrationLogFromRecord(migrationRecord{MigrationID: *id, Name: *name, FromHash: live.SchemaHash, ToHash: want.SchemaHash, Checksum: checksum, Status: "failed", Operations: operations}, *driver, startedAt, time.Now().UTC()).withError(detail))
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
	if err := writeMigrationLog(*logDir, migrationLogFromRecord(migrationRecord{MigrationID: *id, Name: *name, FromHash: live.SchemaHash, ToHash: want.SchemaHash, Checksum: checksum, Status: "applied", Operations: operations}, *driver, startedAt, time.Now().UTC())); err != nil {
		fail(err)
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
	tables = filterManagedTables(tables)
	if len(tables) == 0 {
		return emptyManifest(), nil
	}
	d, err := schema.Parse(renderMermaid(tables, nil))
	if err != nil {
		return nil, err
	}
	return schema.Build(d)
}

func filterManagedTables(tables []impTable) []impTable {
	out := tables[:0]
	for _, table := range tables {
		if table.Name == "orm_schema_migrations" {
			continue
		}
		out = append(out, table)
	}
	return out
}

func readTablesSQLite(db *sql.DB) ([]impTable, error) {
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'orm_schema_migrations' AND name <> 'orm_schema_comments' ORDER BY name`)
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	comments, err := db.Query(`SELECT table_name, column_name, comment FROM orm_schema_comments`)
	if err == nil {
		byTable := make(map[string]*impTable, len(out))
		for i := range out {
			byTable[out[i].Name] = &out[i]
		}
		for comments.Next() {
			var table, column, comment string
			if err := comments.Scan(&table, &column, &comment); err != nil {
				comments.Close()
				return nil, err
			}
			if t := byTable[table]; t != nil {
				if column == "" {
					t.Comment = comment
				} else {
					for i := range t.Columns {
						if t.Columns[i].Name == column {
							t.Columns[i].Comment = comment
						}
					}
				}
			}
		}
		if err := comments.Close(); err != nil {
			return nil, err
		}
	} else if !strings.Contains(strings.ToLower(err.Error()), "no such table") {
		return nil, fmt.Errorf("sqlite schema comments: %w", err)
	}
	return out, nil
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

func executeMigration(ctx context.Context, db *sql.DB, driver, text string) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("MIGRATION_LOCK: reserve connection: %w", err)
	}
	defer conn.Close()
	release := func() error { return nil }
	switch driver {
	case "mysql":
		var acquired sql.NullInt64
		if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(CONCAT('orm:', LEFT(SHA2(DATABASE(), 256), 60)), 0)").Scan(&acquired); err != nil {
			return fmt.Errorf("MIGRATION_LOCK: mysql GET_LOCK: %w", err)
		}
		if !acquired.Valid || acquired.Int64 != 1 {
			return fmt.Errorf("MIGRATION_LOCK_BUSY: mysql database migration lock was not acquired")
		}
		release = func() error {
			var released sql.NullInt64
			if err := conn.QueryRowContext(context.Background(), "SELECT RELEASE_LOCK(CONCAT('orm:', LEFT(SHA2(DATABASE(), 256), 60)))").Scan(&released); err != nil {
				return err
			}
			if !released.Valid || released.Int64 != 1 {
				return fmt.Errorf("mysql migration lock was not released")
			}
			return nil
		}
		if _, err := conn.ExecContext(ctx, "START TRANSACTION"); err != nil {
			_ = release()
			return fmt.Errorf("transaction begin: %w", err)
		}
	case "postgres":
		if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
			return fmt.Errorf("transaction begin: %w", err)
		}
		var acquired bool
		if err := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_xact_lock(hashtext(current_database()), hashtext('polyspec.orm.migration'))").Scan(&acquired); err != nil {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
			return fmt.Errorf("MIGRATION_LOCK: postgres advisory lock: %w", err)
		}
		if !acquired {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
			return fmt.Errorf("MIGRATION_LOCK_BUSY: postgres database migration lock was not acquired")
		}
	case "sqlite":
		if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
			return fmt.Errorf("MIGRATION_LOCK_BUSY: sqlite BEGIN IMMEDIATE: %w", err)
		}
	default:
		return fmt.Errorf("MIGRATION_CONFIG: unsupported driver %q", driver)
	}
	failTx := func(base error) error {
		_, rollbackErr := conn.ExecContext(context.Background(), "ROLLBACK")
		releaseErr := release()
		if rollbackErr != nil || releaseErr != nil {
			return fmt.Errorf("%w; rollback_error=%v; lock_release_error=%v", base, rollbackErr, releaseErr)
		}
		return fmt.Errorf("%w; rollback issued", base)
	}
	for i, stmt := range splitSQL(text) {
		if _, err := conn.ExecContext(ctx, stmt); err != nil {
			return failTx(fmt.Errorf("operation=%d statement=%q: %w", i+1, stmt, err))
		}
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return failTx(fmt.Errorf("transaction commit: %w", err))
	}
	if err := release(); err != nil {
		return fmt.Errorf("MIGRATION_LOCK_RELEASE: %w", err)
	}
	return nil
}

func splitSQL(text string) []string {
	var out []string
	start := 0
	quote := byte(0)
	lineComment, blockComment := false, false
	var dollarTag string
	flush := func(end int) {
		s := strings.TrimSpace(text[start:end])
		if s == "" {
			return
		}
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
	for i := 0; i < len(text); i++ {
		c := text[i]
		if lineComment {
			if c == '\n' {
				lineComment = false
			}
			continue
		}
		if blockComment {
			if c == '*' && i+1 < len(text) && text[i+1] == '/' {
				blockComment = false
				i++
			}
			continue
		}
		if dollarTag != "" {
			if strings.HasPrefix(text[i:], dollarTag) {
				i += len(dollarTag) - 1
				dollarTag = ""
			}
			continue
		}
		if quote != 0 {
			if c == quote {
				if i+1 < len(text) && text[i+1] == quote {
					i++
					continue
				}
				if i > 0 && text[i-1] == '\\' && quote == '\'' {
					continue
				}
				quote = 0
			} else if c == '\\' && quote == '\'' {
				i++
			}
			continue
		}
		if c == '-' && i+1 < len(text) && text[i+1] == '-' {
			lineComment = true
			i++
			continue
		}
		if c == '/' && i+1 < len(text) && text[i+1] == '*' {
			blockComment = true
			i++
			continue
		}
		if c == '\'' || c == '"' || c == '`' {
			quote = c
			continue
		}
		if c == '$' {
			if end := strings.IndexByte(text[i+1:], '$'); end >= 0 {
				candidate := text[i : i+end+2]
				valid := len(candidate) >= 2
				for j, r := range candidate[1 : len(candidate)-1] {
					if !(r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || j > 0 && r >= '0' && r <= '9') {
						valid = false
						break
					}
				}
				if valid {
					dollarTag = candidate
					i += len(candidate) - 1
					continue
				}
			}
		}
		if c == ';' {
			flush(i)
			start = i + 1
		}
	}
	flush(len(text))
	return out
}

func countSQLStatements(text string) int { return len(splitSQL(text)) }

func checksumText(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func migrationLogFromRecord(r migrationRecord, driver string, started, finished time.Time) migrationLog {
	l := migrationLog{MigrationID: r.MigrationID, Name: r.Name, Driver: driver, FromHash: r.FromHash, ToHash: r.ToHash, Checksum: r.Checksum, Status: r.Status, Operations: r.Operations, StartedAt: started.Format(time.RFC3339Nano)}
	if !finished.IsZero() {
		l.FinishedAt = finished.Format(time.RFC3339Nano)
	}
	return l
}

func safeMigrationID(id string) string {
	var b strings.Builder
	for _, r := range id {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "migration"
	}
	return b.String()
}

func migrationLogPath(dir string, log migrationLog) string {
	stamp := strings.ReplaceAll(log.StartedAt, ":", "")
	stamp = strings.ReplaceAll(stamp, "-", "")
	return filepath.Join(dir, stamp+"__"+safeMigrationID(log.MigrationID)+".json")
}

func writeMigrationLog(dir string, log migrationLog) error {
	if dir == "" {
		return fmt.Errorf("MIGRATION_LOG_WRITE: log directory is empty")
	}
	b, err := json.MarshalIndent(log, "", "  ")
	if err != nil {
		return fmt.Errorf("MIGRATION_LOG_WRITE: migration_id=%s: %w", log.MigrationID, err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("MIGRATION_LOG_WRITE: mkdir %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".migration-*.tmp")
	if err != nil {
		return fmt.Errorf("MIGRATION_LOG_WRITE: create temporary file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o644); err == nil {
		_, err = tmp.Write(append(b, '\n'))
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("MIGRATION_LOG_WRITE: migration_id=%s: %w", log.MigrationID, err)
	}
	if err := os.Rename(tmpName, migrationLogPath(dir, log)); err != nil {
		return fmt.Errorf("MIGRATION_LOG_WRITE: migration_id=%s: %w", log.MigrationID, err)
	}
	return nil
}

func verifyMigrationLog(dir string, r migrationRecord, driver string) error {
	paths, err := filepath.Glob(filepath.Join(dir, "*__"+safeMigrationID(r.MigrationID)+".json"))
	if err != nil {
		return fmt.Errorf("MIGRATION_LOG_READ: migration_id=%s: find logs: %w", r.MigrationID, err)
	}
	for _, path := range paths {
		b, readErr := os.ReadFile(path)
		if readErr != nil {
			return fmt.Errorf("MIGRATION_LOG_READ: migration_id=%s file=%s: %w", r.MigrationID, path, readErr)
		}
		var l migrationLog
		if err := json.Unmarshal(b, &l); err != nil {
			return fmt.Errorf("MIGRATION_LOG_READ: migration_id=%s file=%s invalid JSON: %w", r.MigrationID, path, err)
		}
		if l.MigrationID == r.MigrationID && l.Driver == driver && l.FromHash == r.FromHash && l.ToHash == r.ToHash && l.Checksum == r.Checksum && l.Status == r.Status && l.Operations == r.Operations {
			return nil
		}
	}
	return fmt.Errorf("MIGRATION_LOG_CONFLICT: migration_id=%s database record has no matching file log", r.MigrationID)
}

func schemaMatches(want, live *schema.Manifest, driver string) bool {
	if len(want.Entities) != len(live.Entities) {
		return false
	}
	for name, we := range want.Entities {
		le := live.Entities[name]
		if le == nil || we.Table != le.Table || we.Comment != le.Comment || len(we.Columns) != len(le.Columns) {
			return false
		}
		for i, wc := range we.Columns {
			lc := le.Columns[i]
			typeMatch := wc.Type == lc.Type
			if driver == "sqlite" {
				typeMatch = sqliteTypeMatches(wc.Type, lc.Type)
			}
			if wc.Name != lc.Name || wc.Comment != lc.Comment || wc.Nullable != lc.Nullable || !typeMatch {
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
