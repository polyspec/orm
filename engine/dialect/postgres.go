package dialect

import (
	"fmt"
	"strings"
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
func (Postgres) CurrentTime() string      { return "clock_timestamp()" }

// HandlesStyle은 false다. ip stage도 bytea column에 넣을 packed byte를
// executor가 만든다.
func (Postgres) HandlesStyle(string) bool { return false }

func (Postgres) Like(col, ph string) string { return col + " ILIKE " + ph }

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

func (Postgres) ReadExpr(col string, _ []string, _ func() string) (string, int) {
	return col, 0
}

func (Postgres) WriteExpr(ph func() string, _ []string) (string, int) {
	return ph(), 1
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
