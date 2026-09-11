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
	// Like renders col LIKE pattern; caseInsensitive selects ILIKE/LOWER() where needed.
	Like(col, ph string, binary bool) string
	// Limit renders LIMIT/OFFSET.
	Limit(offset, count int) string
	// ForceIndex renders an index hint or "" when unsupported.
	ForceIndex(name string) string
	// Fulltext renders MATCH … AGAINST; boolean selects boolean mode.
	Fulltext(cols []string, ph string, boolean bool) string
	// FulltextValue transforms the search value (compatibility boolean-mode mangling).
	FulltextValue(v string, boolean bool) string
	// RowNumber renders ROW_NUMBER() OVER (PARTITION BY p ORDER BY o).
	RowNumber(partition, orderBy string) string
	// InsertReturningID reports whether INSERT … RETURNING pk is used (else last insert id).
	InsertReturningID() bool
	// Upsert renders the ON DUPLICATE/ON CONFLICT clause for the given conflict columns and assignments.
	Upsert(conflict []string, assigns string) string
	// ReadExpr wraps a column read for a style pipeline (e.g. AES_DECRYPT(UNHEX(col), ?)); returns expr and how many binds it consumed.
	ReadExpr(col string, styles []string, ph func() string) (string, int)
	// WriteExpr wraps a bound value for a style pipeline on write.
	WriteExpr(ph func() string, styles []string) (string, int)
	// Now renders CURRENT_TIMESTAMP.
	Now() string
}

// QuoteWith is a helper for dialects using a single quote character.
func QuoteWith(q string, ident string) string {
	return q + strings.ReplaceAll(ident, q, q+q) + q
}
