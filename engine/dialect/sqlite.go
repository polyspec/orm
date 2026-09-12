package dialect

import (
	"fmt"
	"strings"
)

// SQLite (3.35+ for RETURNING, 3.25+ for window functions). No fulltext outside
// FTS5 virtual tables and no case-sensitive LIKE per expression, so `match` and
// `like_binary` are rejected at compile time rather than approximated. Every
// style stage is app-side here (host AES, packed inet).
type SQLite struct{}

func (SQLite) Name() string              { return "sqlite" }
func (SQLite) Quote(ident string) string { return QuoteWith(`"`, ident) }
func (SQLite) Placeholder(int) string    { return "?" }
func (SQLite) Limit(offset, count int) string {
	return fmt.Sprintf(" LIMIT %d OFFSET %d", count, offset)
}
func (SQLite) ForceIndex(name string) string { return " INDEXED BY " + QuoteWith(`"`, name) }
func (SQLite) InsertReturningID() bool       { return true }
func (SQLite) Now() string                   { return "CURRENT_TIMESTAMP" }
func (SQLite) HandlesStyle(string) bool      { return false }

func (SQLite) Supports(op string) bool {
	return op != "match" && op != "match_boolean" && op != "like_binary"
}

func (SQLite) Like(col, ph string, _ bool) string { return col + " LIKE " + ph + ` ESCAPE '\'` }

func (SQLite) Fulltext(cols []string, ph string, boolean bool) string {
	panic("sqlite: fulltext is rejected by Supports")
}

func (SQLite) FulltextValue(v string, _ bool) string { return v }

func (SQLite) RowNumber(partition, orderBy string) string {
	s := "ROW_NUMBER() OVER (PARTITION BY " + partition
	if orderBy != "" {
		s += " ORDER BY " + orderBy
	}
	return s + ")"
}

func (SQLite) Upsert(conflict []string, assigns string) string {
	q := make([]string, len(conflict))
	for i, c := range conflict {
		q[i] = QuoteWith(`"`, c)
	}
	return " ON CONFLICT (" + strings.Join(q, ", ") + ") DO UPDATE SET " + assigns
}

func (SQLite) ReadExpr(col, _ string, _ []string, _ func() string) (string, int) { return col, 0 }
func (SQLite) WriteExpr(ph func() string, _ string, _ []string) (string, int)    { return ph(), 1 }

func (SQLite) HostNow() bool { return true }
