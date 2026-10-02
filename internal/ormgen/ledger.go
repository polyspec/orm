package ormgen

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// The migration ledger orm_schema_migrations stores started_at and
// finished_at with six fraction digits on every database (docs/protocol.md).

// ledgerTimeGlob is the SQLite form of a ledger time: UTC text with six
// fraction digits.
const ledgerTimeGlob = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]'"

// sqliteLedgerTimeColumns are the SQLite definitions of the ledger time
// columns. SQLite keeps a column definition only in the table statement, so
// an existing ledger is verified against these texts.
var sqliteLedgerTimeColumns = [][2]string{
	{"started_at", "started_at TEXT NOT NULL CHECK (started_at GLOB " + ledgerTimeGlob + ")"},
	{"finished_at", "finished_at TEXT NULL CHECK (finished_at GLOB " + ledgerTimeGlob + ")"},
}

func ledgerStatement(driver string) string {
	switch driver {
	case "mysql":
		return "CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL, from_schema_hash varchar(128) NOT NULL, to_schema_hash varchar(128) NOT NULL, plan_checksum varchar(128) NOT NULL, status varchar(32) NOT NULL, operations int NOT NULL, error_detail text NOT NULL, started_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), finished_at timestamp(6) NULL)"
	case "postgres":
		return "CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz NULL)"
	default:
		return "CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, " + sqliteLedgerTimeColumns[0][1] + ", " + sqliteLedgerTimeColumns[1][1] + ")"
	}
}

// ensureMigrationTable creates the ledger when it is missing and verifies
// the time columns of an existing ledger. A ledger with other time columns
// fails with MIGRATION_HISTORY_PRECISION and stays unchanged.
func ensureMigrationTable(ctx context.Context, db *sql.DB, driver string) error {
	if _, err := db.ExecContext(ctx, ledgerStatement(driver)); err != nil {
		return fmt.Errorf("MIGRATION_HISTORY_CREATE: driver=%s: %w", driver, err)
	}
	return verifyLedgerTimes(ctx, db, driver)
}

func verifyLedgerTimes(ctx context.Context, db *sql.DB, driver string) error {
	if driver == "sqlite" {
		var statement string
		if err := db.QueryRowContext(ctx, "SELECT sql FROM sqlite_master WHERE type='table' AND name='orm_schema_migrations'").Scan(&statement); err != nil {
			return fmt.Errorf("MIGRATION_HISTORY_READ: driver=sqlite definition: %w", err)
		}
		for _, column := range sqliteLedgerTimeColumns {
			if !strings.Contains(statement, column[1]) {
				return fmt.Errorf("MIGRATION_HISTORY_PRECISION: driver=sqlite column=%s required=%q", column[0], column[1])
			}
		}
		return nil
	}
	q := "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orm_schema_migrations' AND COLUMN_NAME = ?"
	required := []string{"timestamp(6)"}
	if driver == "postgres" {
		q = "SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = to_regclass('orm_schema_migrations') AND attname = $1 AND attnum > 0 AND NOT attisdropped"
		required = []string{"timestamp with time zone", "timestamp(6) with time zone"}
	}
	for _, column := range []string{"started_at", "finished_at"} {
		var definition string
		err := db.QueryRowContext(ctx, q, column).Scan(&definition)
		if errors.Is(err, sql.ErrNoRows) {
			definition = "missing"
		} else if err != nil {
			return fmt.Errorf("MIGRATION_HISTORY_READ: driver=%s column=%s: %w", driver, column, err)
		}
		if !containsString(required, definition) {
			return fmt.Errorf("MIGRATION_HISTORY_PRECISION: driver=%s column=%s definition=%q required=%q", driver, column, definition, required[0])
		}
	}
	return nil
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// ledgerClock is the clock a ledger write assigns: the database clock with
// microseconds on MySQL and PostgreSQL, and on SQLite, which has no clock
// with microseconds, the tool clock in UTC bound as the returned argument.
func ledgerClock(driver string) (string, []any) {
	switch driver {
	case "mysql":
		return "CURRENT_TIMESTAMP(6)", nil
	case "postgres":
		return "CURRENT_TIMESTAMP", nil
	default:
		return "?", []any{time.Now().UTC().Format("2006-01-02 15:04:05.000000")}
	}
}

// ledgerArgs places the clock arguments after the first n arguments, where
// the clock expression stands in the statement.
func ledgerArgs(args []any, n int, clock []any) []any {
	out := append([]any{}, args[:n]...)
	out = append(out, clock...)
	return append(out, args[n:]...)
}
