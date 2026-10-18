package dialect

import (
	"fmt"
	"strings"
)

// SQLite (3.35+ for RETURNING, 3.25+ for window functions). No fulltext outside
// FTS5 virtual tables, so `match` is rejected at compile time rather than
// approximated. Every
// style stage is client-side here (host AES, packed inet).
type SQLite struct{}

func (SQLite) Name() string { return "sqlite" }
func (SQLite) Quote(ident string) string {
	parts := strings.Split(ident, ".")
	if len(parts) == 1 {
		return QuoteWith(`"`, parts[0])
	}
	return QuoteWith(`"`, strings.Join(parts, "__"))
}
func (SQLite) Placeholder(int) string { return "?" }
func (SQLite) Limit(offset, count int) string {
	return fmt.Sprintf(" LIMIT %d OFFSET %d", count, offset)
}
func (SQLite) ForceIndex(name string) string { return " INDEXED BY " + QuoteWith(`"`, name) }
func (SQLite) InsertReturningID() bool       { return true }
func (SQLite) Now(int) string                { return "CURRENT_TIMESTAMP" }
func (SQLite) HandlesStyle(string) bool      { return false }
func (SQLite) DecodesStyle(string) bool      { return false }

func (SQLite) Like(col, ph string) string { return col + " LIKE " + ph + ` ESCAPE '\'` }

func (SQLite) RowNumber(partition, orderBy string) string {
	s := "ROW_NUMBER() OVER (PARTITION BY " + partition
	if orderBy != "" {
		s += " ORDER BY " + orderBy
	}
	return s + ")"
}

// RestartIdentity: the next key of an AUTOINCREMENT table is the seq in sqlite_sequence plus 1,
// so seq is set to the largest key. A table that has not yet received rows has
// no sqlite_sequence row, so the next key is already the one after the largest key.
func (SQLite) RestartIdentity(table, column string) string {
	return "UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(" + QuoteWith(`"`, column) + "), 0) FROM " + QuoteWith(`"`, table) + ") WHERE name = " + Literal(table)
}

func (SQLite) Upsert(conflict []string, assigns string) string {
	q := make([]string, len(conflict))
	for i, c := range conflict {
		q[i] = QuoteWith(`"`, c)
	}
	return " ON CONFLICT (" + strings.Join(q, ", ") + ") DO UPDATE SET " + assigns
}

func (SQLite) ReadExpr(col string, _ []string, _ func() string) (string, int) { return col, 0 }
func (SQLite) WriteExpr(ph func() string, _ []string) (string, int)           { return ph(), 1 }

func (SQLite) HostNow() bool                     { return true }
func (SQLite) ReadTime(col string, _ int) string { return col }
func (SQLite) WriteTime(ph string) string        { return ph }

// ClockOperand extends a datetime(p < 6) text to six fraction digits, so it compares
// with the six-digit clock as the value it is: `col || '.000000'` for p = 0 and the
// missing zeros for 0 < p < 6.
func (SQLite) ClockOperand(col string, precision int) string {
	switch {
	case precision >= 6:
		return col
	case precision == 0:
		return "(" + col + " || '.000000')"
	}
	return "(" + col + " || '" + strings.Repeat("0", 6-precision) + "')"
}

// SQLite has no row-lock clause. Each executor implements the common lock
// modes with an ORM-owned transaction-scoped lock row; the SQL suffix remains
// empty because the physical lock is acquired by the adapter.
func (SQLite) RowLock(mode string) (string, bool) {
	switch mode {
	case "update", "share", "update_nowait", "share_nowait":
		return "", true
	default:
		return "", false
	}
}

func (SQLite) ReadUUID(col string) string { return col }
func (SQLite) WriteUUID(ph string) string { return ph }
