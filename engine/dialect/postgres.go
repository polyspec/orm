package dialect

import (
	"fmt"
	"strings"
)

// Postgres: "quoted" identifiers, $n placeholders, ILIKE for the case-insensitive
// LIKE MySQL gives by collation, ON CONFLICT upserts with RETURNING ids. AES and
// HEX have no SQL-side stage here: those styles stay app-side (host AES, S6).
type Postgres struct{}

func (Postgres) Name() string              { return "postgres" }
func (Postgres) Quote(ident string) string { return QuoteWith(`"`, ident) }
func (Postgres) Placeholder(n int) string  { return fmt.Sprintf("$%d", n) }
func (Postgres) Limit(offset, count int) string {
	return fmt.Sprintf(" LIMIT %d OFFSET %d", count, offset)
}
func (Postgres) ForceIndex(string) string   { return "" } // planner hints are not a thing in PostgreSQL
func (Postgres) InsertReturningID() bool    { return true }
func (Postgres) Now() string                { return "CURRENT_TIMESTAMP" }
func (Postgres) CurrentTime() string        { return "clock_timestamp()" }
func (Postgres) Supports(op string) bool    { return true }
func (Postgres) HandlesStyle(s string) bool { return s == "ip" }

func (Postgres) Like(col, ph string, binary bool) string {
	if binary {
		return col + " LIKE " + ph
	}
	return col + " ILIKE " + ph
}

// Fulltext: the "simple" configuration keeps the semantics language-neutral;
// boolean mode maps to websearch syntax (quotes, -, or), the closest thing to
// MySQL's boolean operators.
func (Postgres) Fulltext(cols []string, ph string, boolean bool) string {
	doc := strings.Join(cols, " || ' ' || ")
	if len(cols) > 1 {
		doc = "coalesce(" + strings.Join(cols, ", '') || ' ' || coalesce(") + ", '')"
	}
	fn := "plainto_tsquery"
	if boolean {
		fn = "websearch_to_tsquery"
	}
	return "to_tsvector('simple', " + doc + ") @@ " + fn + "('simple', " + ph + ")"
}

func (Postgres) FulltextValue(v string, _ bool) string { return strings.TrimSpace(v) }

func (Postgres) RowNumber(partition, orderBy string) string {
	s := "ROW_NUMBER() OVER (PARTITION BY " + partition
	if orderBy != "" {
		s += " ORDER BY " + orderBy
	}
	return s + ")"
}

func (Postgres) Upsert(conflict []string, assigns string) string {
	q := make([]string, len(conflict))
	for i, c := range conflict {
		q[i] = QuoteWith(`"`, c)
	}
	return " ON CONFLICT (" + strings.Join(q, ", ") + ") DO UPDATE SET " + assigns
}

func (Postgres) ReadExpr(col, colType string, styles []string, _ func() string) (string, int) {
	if colType == "point" {
		col = "(" + col + ")::text"
	}
	for _, s := range styles {
		if s == "ip" {
			return "host(" + col + ")", 0
		}
	}
	return col, 0
}

func (Postgres) WriteExpr(ph func() string, colType string, styles []string) (string, int) {
	expr := ph()
	if colType == "point" {
		expr = "CAST(" + expr + " AS text)::point"
	}
	for _, s := range styles {
		if s == "ip" {
			expr = "(" + expr + ")::inet"
		}
	}
	return expr, 1
}

func (Postgres) HostNow() bool { return false }
func (Postgres) RowLock(mode string) (string, bool) {
	switch mode {
	case "update":
		return " FOR UPDATE", true
	case "share":
		return " FOR SHARE", true
	case "update_nowait":
		return " FOR UPDATE NOWAIT", true
	case "share_nowait":
		return " FOR SHARE NOWAIT", true
	default:
		return "", false
	}
}
