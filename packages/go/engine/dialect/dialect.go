// Package dialect renders the database-specific pieces of SQL. The planner
// never writes a quote or a placeholder itself.
package dialect

import "strings"

type Dialect interface {
	Name() string
	// Quote an identifier.
	Quote(ident string) string
	// Placeholder for the n-th (1-based) bind.
	Placeholder(n int) string
	// Like renders the case-insensitive col LIKE pattern of contains.
	Like(col, ph string) string
	// Limit renders LIMIT/OFFSET.
	Limit(offset, count int) string
	// ForceIndex renders an index hint or "" when unsupported.
	ForceIndex(name string) string
	// RowNumber renders ROW_NUMBER() OVER (PARTITION BY p ORDER BY o).
	RowNumber(partition, orderBy string) string
	// InsertReturningID reports whether INSERT … RETURNING pk is used (else last insert id).
	InsertReturningID() bool
	// Upsert renders the ON DUPLICATE/ON CONFLICT clause for the given conflict columns and assignments.
	Upsert(conflict []string, assigns string) string
	// ReadExpr wraps SQL-side stages for a style pipeline and returns the bind count.
	ReadExpr(col string, styles []string, ph func() string) (string, int)
	// WriteExpr wraps a bound value for a style pipeline on write.
	WriteExpr(ph func() string, styles []string) (string, int)
	// ReadTime reads a time(p) column as its value text `HH:MM:SS` with exactly p
	// fraction digits, which the database writes (MySQL CAST AS CHAR, PostgreSQL
	// to_char); SQLite stores that text.
	ReadTime(col string, precision int) string
	// WriteTime binds a time(p) value as its text: PostgreSQL casts the text to time.
	WriteTime(ph string) string
	// ReadUUID reads a uuid column as its text: PostgreSQL casts the uuid to text.
	ReadUUID(col string) string
	// WriteUUID binds a uuid value as its text: PostgreSQL casts the text to uuid.
	WriteUUID(ph string) string
	// Now renders the database clock that is written to a column, with precision fractional digits:
	// MySQL uses CURRENT_TIMESTAMP(p) if p > 0, and CURRENT_TIMESTAMP otherwise.
	Now(precision int) string
	// HandlesStyle reports whether the write applies the codec stage in this dialect's SQL
	// (MySQL: ip). The other stages, including hex, are applied by the executor.
	HandlesStyle(style string) bool
	// DecodesStyle reports whether the read undoes the codec stage in this dialect's SQL (MySQL: ip).
	// No dialect undoes hex in SQL: UNHEX accepts odd lengths and returns NULL for cells with spaces,
	// so the executor reads it correctly with HostDecode (docs/codec.md).
	DecodesStyle(style string) bool
	// HostNow reports that the clock the ORM writes comes from the executor (a `now`
	// slot truncated to the column's fraction digits): SQLite has no sub-second clock
	// function, and a PostgreSQL clock rounds into timestamp(p < 6)
	// (postgres.now.precision_rounds). The update time, soft deletion and every omitted
	// `default now` column of an insert bind the slot (docs/protocol.md "Clock").
	HostNow() bool
	// ClockOperand is a datetime(p) column as it compares with the six-digit clock of a
	// value function: SQLite compares text, so a column with p < 6 is extended with
	// zeros to six fraction digits; MySQL and PostgreSQL compare values.
	ClockOperand(col string, precision int) string
	// RowLock renders a row lock suffix. An empty suffix with true means the
	// executor owns a portable adapter-level lock implementation.
	RowLock(mode string) (string, bool)
	// ColumnFunction renders an ORM column function applied to col; arg(i)
	// returns a new placeholder bound to the i-th function argument.
	ColumnFunction(name, col string, arg func(int) string) (string, bool)
	// ValueFunction renders an ORM value function; arg returns a placeholder
	// for the interval amount and now binds the executor clock. Both are called
	// in SQL text order.
	ValueFunction(name string, arg, now func() string) (string, bool)
	// ContainsBinary renders a case-sensitive substring match; value returns a
	// placeholder whose bound value gets the named transform.
	ContainsBinary(col string, value func(transform string) string) string
	// TupleIn renders a multi-column IN or NOT IN list.
	TupleIn(cols []string, rows [][]string, negate bool) string
	// Random renders the random ordering function.
	Random() string
	// NullsOrder renders the clause that sorts NULL before every value ascending and after every value descending:
	// MySQL and SQLite do so natively and render nothing, PostgreSQL sorts NULL last ascending and needs it.
	NullsOrder(desc bool) string
	// RestartIdentity is the statement that restarts a table's identity column from the value after the largest key.
	// If the table is empty, the next key is 1.
	RestartIdentity(table, column string) string
}

// Literal quotes text as a SQL string literal.
func Literal(text string) string {
	return "'" + strings.ReplaceAll(text, "'", "''") + "'"
}

// QuoteWith is a helper for dialects using a single quote character.
func QuoteWith(q string, ident string) string {
	parts := strings.Split(ident, ".")
	for i := range parts {
		parts[i] = q + strings.ReplaceAll(parts[i], q, q+q) + q
	}
	return strings.Join(parts, ".")
}
