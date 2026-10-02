package ormgen

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The migration ledger cases run on SQLite, MySQL and PostgreSQL.
// ORM_TOOLS_MYSQL_DSN and ORM_TOOLS_POSTGRES_DSN name dedicated databases; the
// cases drop the ledger in them.

var ledgerTime = regexp.MustCompile(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$`)

type ledgerTarget struct{ driver, dsn string }

func ledgerTargets(t *testing.T) []ledgerTarget {
	t.Helper()
	out := []ledgerTarget{{"sqlite", "sqlite://" + filepath.Join(t.TempDir(), "ledger.sqlite")}}
	for _, tc := range []struct{ driver, env string }{{"mysql", "ORM_TOOLS_MYSQL_DSN"}, {"postgres", "ORM_TOOLS_POSTGRES_DSN"}} {
		dsn := os.Getenv(tc.env)
		if dsn == "" {
			t.Fatalf("%s is required; database tests never skip", tc.env)
		}
		out = append(out, ledgerTarget{tc.driver, dsn})
	}
	return out
}

// runLedgerCase opens each target, drops the ledger before and after the
// case, and reports the elapsed time of each database under its own deadline.
func runLedgerCase(t *testing.T, name string, body func(t *testing.T, ctx context.Context, db *sql.DB, driver string)) {
	for _, target := range ledgerTargets(t) {
		t.Run(target.driver, func(t *testing.T) {
			started := time.Now()
			t.Logf("RUN %s/%s", name, target.driver)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			db, opened, err := openToolDB(target.dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if opened.dialect != target.driver {
				t.Fatalf("the %s DSN names a %s database", target.driver, opened.dialect)
			}
			drop := func() {
				if _, err := db.ExecContext(context.Background(), "DROP TABLE IF EXISTS orm_schema_migrations"); err != nil {
					t.Fatal(err)
				}
			}
			drop()
			defer drop()
			body(t, ctx, db, target.driver)
			t.Logf("DONE %s/%s %s", name, target.driver, time.Since(started))
		})
	}
}

// ledgerTimes reads every stored ledger time as text in UTC: the stored text
// on SQLite, the column rendered with its declared fraction digits on MySQL,
// and six fraction digits on PostgreSQL. A NULL finishing time is "NULL".
func ledgerTimes(t *testing.T, ctx context.Context, db *sql.DB, driver string) [][]string {
	t.Helper()
	q := "SELECT migration_id, started_at, finished_at FROM orm_schema_migrations ORDER BY migration_id"
	switch driver {
	case "mysql":
		q = "SELECT migration_id, CAST(started_at AS CHAR), CAST(finished_at AS CHAR) FROM orm_schema_migrations ORDER BY migration_id"
	case "postgres":
		q = "SELECT migration_id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') FROM orm_schema_migrations ORDER BY migration_id"
	}
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out [][]string
	for rows.Next() {
		var id string
		var started, finished sql.NullString
		if err := rows.Scan(&id, &started, &finished); err != nil {
			t.Fatal(err)
		}
		row := []string{id}
		for _, v := range []sql.NullString{started, finished} {
			if v.Valid {
				row = append(row, v.String)
			} else {
				row = append(row, "NULL")
			}
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestMigrationLedgerMicroseconds is the case migration_ledger_microseconds:
// three migrations record their start and finish, and every stored time has
// six fraction digits, at least one of them not 000000.
func TestMigrationLedgerMicroseconds(t *testing.T) {
	runLedgerCase(t, "migration_ledger_microseconds", func(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
		if err := ensureMigrationTable(ctx, db, driver); err != nil {
			t.Fatal(err)
		}
		for i := 1; i <= 3; i++ {
			id := fmt.Sprintf("m%d", i)
			if err := insertMigration(ctx, db, driver, migrationRecord{MigrationID: id, Name: "ledger", FromHash: "from", ToHash: "to", Checksum: "sum", Status: "queued"}); err != nil {
				t.Fatal(err)
			}
			if err := executeClaimedMigration(ctx, db, driver, id, "queued", ""); err != nil {
				t.Fatal(err)
			}
			if err := updateMigration(ctx, db, driver, id, "applied", ""); err != nil {
				t.Fatal(err)
			}
		}
		rows := ledgerTimes(t, ctx, db, driver)
		if len(rows) != 3 {
			t.Fatalf("ledger rows=%v", rows)
		}
		fractions := 0
		for _, row := range rows {
			for _, v := range row[1:] {
				if !ledgerTime.MatchString(v) {
					t.Fatalf("%s ledger time %q of %s has no six fraction digits; rows=%v", driver, v, row[0], rows)
				}
				if !strings.HasSuffix(v, ".000000") {
					fractions++
				}
			}
		}
		if fractions == 0 {
			t.Fatalf("%s ledger times have no fraction: %v", driver, rows)
		}
	})
}

// wholeSecondLedger is a ledger whose times keep whole seconds: the statement
// of the tools before the microsecond ledger on MySQL and SQLite, and
// timestamptz(0) on PostgreSQL.
var wholeSecondLedger = map[string]string{
	"mysql":    "CREATE TABLE orm_schema_migrations (migration_id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL, from_schema_hash varchar(128) NOT NULL, to_schema_hash varchar(128) NOT NULL, plan_checksum varchar(128) NOT NULL, status varchar(32) NOT NULL, operations int NOT NULL, error_detail text NOT NULL, started_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamp NULL)",
	"postgres": "CREATE TABLE orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz(0) NULL)",
	"sqlite":   "CREATE TABLE orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT NULL)",
}

// TestMigrationLedgerWholeSeconds is the case migration_ledger_whole_seconds:
// a ledger with whole-second time columns fails with
// MIGRATION_HISTORY_PRECISION, and its definition and rows stay unchanged.
func TestMigrationLedgerWholeSeconds(t *testing.T) {
	runLedgerCase(t, "migration_ledger_whole_seconds", func(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
		for _, q := range []string{
			wholeSecondLedger[driver],
			"INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail,started_at,finished_at) VALUES ('old','old','from','to','sum','applied',1,'','2026-01-02 03:04:05','2026-01-02 03:04:06')",
		} {
			if _, err := db.ExecContext(ctx, q); err != nil {
				t.Fatal(err)
			}
		}
		before := ledgerTimes(t, ctx, db, driver)
		definition := ledgerDefinition(t, ctx, db, driver)
		err := ensureMigrationTable(ctx, db, driver)
		want := "MIGRATION_HISTORY_PRECISION: driver=" + driver + " column=started_at"
		if err == nil || !strings.HasPrefix(err.Error(), want) {
			t.Fatalf("%s whole-second ledger: want %s, got %v", driver, want, err)
		}
		if after := ledgerTimes(t, ctx, db, driver); !reflect.DeepEqual(before, after) {
			t.Fatalf("%s ledger rows changed: before=%v after=%v", driver, before, after)
		}
		if got := ledgerDefinition(t, ctx, db, driver); got != definition {
			t.Fatalf("%s ledger definition changed: before=%s after=%s", driver, definition, got)
		}
	})
}

// ledgerDefinition reads the stored definition of the ledger time columns.
func ledgerDefinition(t *testing.T, ctx context.Context, db *sql.DB, driver string) string {
	t.Helper()
	q := "SELECT sql FROM sqlite_master WHERE type='table' AND name='orm_schema_migrations'"
	switch driver {
	case "mysql":
		q = "SELECT GROUP_CONCAT(CONCAT(COLUMN_NAME, ' ', COLUMN_TYPE) ORDER BY COLUMN_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orm_schema_migrations'"
	case "postgres":
		q = "SELECT string_agg(attname || ' ' || format_type(atttypid, atttypmod), ',' ORDER BY attname) FROM pg_attribute WHERE attrelid = to_regclass('orm_schema_migrations') AND attnum > 0 AND NOT attisdropped"
	}
	var definition string
	if err := db.QueryRowContext(ctx, q).Scan(&definition); err != nil {
		t.Fatal(err)
	}
	return definition
}

// earlierLedger is the ledger statement of the tools before the microsecond
// ledger.
var earlierLedger = map[string]string{
	"mysql":    wholeSecondLedger["mysql"],
	"postgres": "CREATE TABLE orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz NULL)",
	"sqlite":   wholeSecondLedger["sqlite"],
}

// ledgerConversion is the conversion of an earlier ledger in docs/usage.md;
// an earlier PostgreSQL ledger needs none.
var ledgerConversion = map[string][]string{
	"mysql": {"ALTER TABLE orm_schema_migrations MODIFY started_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), MODIFY finished_at timestamp(6) NULL"},
	"sqlite": {
		"BEGIN",
		"ALTER TABLE orm_schema_migrations RENAME TO orm_schema_migrations_seconds",
		"CREATE TABLE orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, started_at TEXT NOT NULL CHECK (started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]'), finished_at TEXT NULL CHECK (finished_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]'))",
		"INSERT INTO orm_schema_migrations SELECT migration_id, name, from_schema_hash, to_schema_hash, plan_checksum, status, operations, error_detail, started_at || '.000000', finished_at || '.000000' FROM orm_schema_migrations_seconds",
		"DROP TABLE orm_schema_migrations_seconds",
		"COMMIT",
	},
}

// TestMigrationLedgerEarlier is the case migration_ledger_earlier: an earlier
// ledger converted with the statements of docs/usage.md, and an earlier
// PostgreSQL ledger as it is, keep their rows with the fraction 000000 and
// take a new migration with six fraction digits.
func TestMigrationLedgerEarlier(t *testing.T) {
	runLedgerCase(t, "migration_ledger_earlier", func(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
		conn, err := db.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		for _, q := range append([]string{
			earlierLedger[driver],
			"INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail,started_at,finished_at) VALUES ('old','old','from','to','sum','applied',1,'','2026-01-02 03:04:05','2026-01-02 03:04:06')",
		}, ledgerConversion[driver]...) {
			if _, err := conn.ExecContext(ctx, q); err != nil {
				t.Fatalf("%s: %v", q, err)
			}
		}
		if err := ensureMigrationTable(ctx, db, driver); err != nil {
			t.Fatal(err)
		}
		if err := insertMigration(ctx, db, driver, migrationRecord{MigrationID: "new", Name: "ledger", FromHash: "from", ToHash: "to", Checksum: "sum", Status: "queued"}); err != nil {
			t.Fatal(err)
		}
		if err := updateMigration(ctx, db, driver, "new", "applied", ""); err != nil {
			t.Fatal(err)
		}
		rows := ledgerTimes(t, ctx, db, driver)
		if len(rows) != 2 || rows[1][0] != "old" {
			t.Fatalf("%s ledger rows=%v", driver, rows)
		}
		for _, v := range append(rows[0][1:], rows[1][1:]...) {
			if !ledgerTime.MatchString(v) {
				t.Fatalf("%s ledger time %q has no six fraction digits; rows=%v", driver, v, rows)
			}
		}
		if !strings.HasSuffix(rows[1][1], ":05.000000") || !strings.HasSuffix(rows[1][2], ":06.000000") {
			t.Fatalf("%s earlier row lost its seconds: %v", driver, rows[1])
		}
	})
}
