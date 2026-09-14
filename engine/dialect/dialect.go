// Package dialect renders the database-specific pieces of SQL. The planner
// never writes a quote or a placeholder itself.
package dialect

import "strings"

// CurrentTimeToken is replaced in trusted ORM expression fragments with the
// dialect's advancing wall-clock expression.
const CurrentTimeToken = "$CURRENT_TIME"

type Dialect interface {
	Name() string
	// Quote an identifier.
	Quote(ident string) string
	// Placeholder for the n-th (1-based) bind.
	Placeholder(n int) string
	// Like renders col LIKE pattern; caseInsensitive selects ILIKE/LOWER() where needed.
	Like(col, ph string, binary bool) string
	// Limit renders LIMIT/OFFSET.
	Limit(offset, count int) string
	// ForceIndex renders an index hint or "" when unsupported.
	ForceIndex(name string) string
	// Fulltext renders MATCH … AGAINST; boolean selects boolean mode.
	Fulltext(cols []string, ph string, boolean bool) string
	// FulltextValue transforms the search value for boolean full-text mode.
	FulltextValue(v string, boolean bool) string
	// RowNumber renders ROW_NUMBER() OVER (PARTITION BY p ORDER BY o).
	RowNumber(partition, orderBy string) string
	// InsertReturningID reports whether INSERT … RETURNING pk is used (else last insert id).
	InsertReturningID() bool
	// Upsert renders the ON DUPLICATE/ON CONFLICT clause for the given conflict columns and assignments.
	Upsert(conflict []string, assigns string) string
	// ReadExpr wraps SQL-side stages for a style pipeline and returns the bind count.
	ReadExpr(col, colType string, styles []string, ph func() string) (string, int)
	// WriteExpr wraps a bound value for a style pipeline on write.
	WriteExpr(ph func() string, colType string, styles []string) (string, int)
	// Now renders CURRENT_TIMESTAMP.
	Now() string
	// CurrentTime renders a wall-clock expression that advances during a transaction.
	CurrentTime() string
	// Supports reports whether a predicate operator exists in this dialect (false → OPERATOR_NOT_ALLOWED).
	Supports(op string) bool
	// HandlesStyle reports whether a column style stage is applied in SQL here
	// (MySQL: aes/hex/ip); the rest of the stack is left to the executor.
	HandlesStyle(style string) bool
	// HostNow reports that the database has no sub-second clock function, so
	// timestamps written by the ORM (updated_ts) come from the executor (a `now` slot).
	HostNow() bool
	// RowLock renders a row lock suffix. The boolean reports dialect support.
	RowLock(mode string) (string, bool)
}

// QuoteWith is a helper for dialects using a single quote character.
func QuoteWith(q string, ident string) string {
	parts := strings.Split(ident, ".")
	for i := range parts {
		parts[i] = q + strings.ReplaceAll(parts[i], q, q+q) + q
	}
	return strings.Join(parts, ".")
}
