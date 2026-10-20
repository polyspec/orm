package dialect

import (
	"fmt"
)

// Postgres: "quoted" identifiers, $n placeholders, ILIKE for the case-insensitive
// LIKE MySQL gives by collation, ON CONFLICT upserts with RETURNING ids. AES and
// HEX have no SQL-side stage here: those styles stay client-side (host AES, S6).
type Postgres struct{}

func (Postgres) Name() string              { return "postgres" }
func (Postgres) Quote(ident string) string { return QuoteWith(`"`, ident) }
func (Postgres) Placeholder(n int) string  { return fmt.Sprintf("$%d", n) }
func (Postgres) Limit(offset, count int) string {
	return fmt.Sprintf(" LIMIT %d OFFSET %d", count, offset)
}
func (Postgres) ForceIndex(string) string { return "" } // planner hints are not a thing in PostgreSQL
func (Postgres) InsertReturningID() bool  { return true }
func (Postgres) Now(int) string           { return "CURRENT_TIMESTAMP" }

// HandlesStyle is false: the packed bytes for the bytea column, including the ip stage, are made by the
// executor.
func (Postgres) HandlesStyle(string) bool { return false }

func (Postgres) DecodesStyle(string) bool { return false }

func (Postgres) Like(col, ph string) string { return col + " ILIKE " + ph }

func (Postgres) RowNumber(partition, orderBy string) string {
	s := "ROW_NUMBER() OVER (PARTITION BY " + partition
	if orderBy != "" {
		s += " ORDER BY " + orderBy
	}
	return s + ")"
}

// RestartIdentity: sets the identity sequence to the largest key plus 1 and sets is_called
// to false, so that the next nextval returns that value. The first argument of pg_get_serial_sequence
// is read as an identifier, so it is the quoted table name; the second argument is the column name as is.
func (Postgres) RestartIdentity(table, column string) string {
	q := QuoteWith(`"`, column)
	return "SELECT setval(pg_get_serial_sequence(" + Literal(QuoteWith(`"`, table)) + ", " + Literal(column) + "), COALESCE(MAX(" + q + "), 0) + 1, false) FROM " + QuoteWith(`"`, table)
}

func (Postgres) Upsert(conflict []string, assigns string) string {
	return upsert(conflict, assigns)
}

func (Postgres) ReadExpr(col string, _ []string, _ func() string) (string, int) {
	return col, 0
}

func (Postgres) WriteExpr(ph func() string, _ []string) (string, int) {
	return ph(), 1
}

func (Postgres) HostNow() bool                         { return true }
func (Postgres) ClockOperand(col string, _ int) string { return col }
func (Postgres) ReadTime(col string, precision int) string {
	if precision == 0 {
		return "to_char(" + col + ", 'HH24:MI:SS')"
	}
	return fmt.Sprintf("substr(to_char(%s, 'HH24:MI:SS.US'), 1, %d)", col, 9+precision)
}
func (Postgres) WriteTime(ph string) string { return "CAST(CAST(" + ph + " AS text) AS time)" }
func (Postgres) RowLock(mode string) (string, bool) {
	return rowLock(mode)
}

func (Postgres) ReadUUID(col string) string { return "CAST(" + col + " AS text)" }
func (Postgres) WriteUUID(ph string) string { return "CAST(CAST(" + ph + " AS text) AS uuid)" }
