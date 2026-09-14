package dialect

import (
	"fmt"
	"strings"
)

// MySQL is the primary dialect. Style expressions are defined to preserve the
// stored byte representation
// AES is host-side; hex and IP packing remain SQL-side.
type MySQL struct{}

func (MySQL) Name() string                   { return "mysql" }
func (MySQL) Quote(ident string) string      { return QuoteWith("`", ident) }
func (MySQL) Placeholder(int) string         { return "?" }
func (MySQL) Limit(offset, count int) string { return fmt.Sprintf(" LIMIT %d, %d", offset, count) }
func (MySQL) ForceIndex(name string) string  { return " FORCE INDEX (" + QuoteWith("`", name) + ")" }
func (MySQL) InsertReturningID() bool        { return false }
func (MySQL) Now() string                    { return "CURRENT_TIMESTAMP" }
func (MySQL) CurrentTime() string            { return "CURRENT_TIMESTAMP" }
func (MySQL) Supports(string) bool           { return true }
func (MySQL) HostNow() bool                  { return false }
func (MySQL) RowLock(mode string) (string, bool) {
	switch mode {
	case "update":
		return " FOR UPDATE", true
	case "share":
		return " FOR SHARE", true
	default:
		return "", false
	}
}

// AES is host-side so row version metadata can select the key before decode.
// hex and ip remain SQL-side because they do not depend on a secret.
func (MySQL) HandlesStyle(s string) bool { return s == "hex" || s == "ip" }

func (MySQL) Like(col, ph string, binary bool) string {
	if binary {
		return col + " LIKE BINARY " + ph
	}
	return col + " LIKE " + ph
}

func (MySQL) Fulltext(cols []string, ph string, boolean bool) string {
	mode := " IN NATURAL LANGUAGE MODE"
	if boolean {
		mode = " IN BOOLEAN MODE"
	}
	return "MATCH(" + strings.Join(cols, ", ") + ") AGAINST (" + ph + mode + ")"
}

// FulltextValue normalizes boolean full-text input: "foo bar" → "+foo +bar*".
func (MySQL) FulltextValue(v string, boolean bool) string {
	if !boolean {
		return v
	}
	v = strings.TrimSpace(v)
	if v == "" {
		return v
	}
	return "+" + strings.ReplaceAll(v, " ", " +") + "*"
}

func (MySQL) RowNumber(partition, orderBy string) string {
	s := "ROW_NUMBER() OVER (PARTITION BY " + partition
	if orderBy != "" {
		s += " ORDER BY " + orderBy
	}
	return s + ")"
}

func (MySQL) Upsert(_ []string, assigns string) string {
	return " ON DUPLICATE KEY UPDATE " + assigns
}

// ReadExpr applies SQL-side stages. AES is handled by the executor so it can
// select the key from the row's version metadata.
func (MySQL) ReadExpr(col, colType string, styles []string, ph func() string) (string, int) {
	if colType == "point" {
		col = "ST_AsText(" + col + ")"
	}
	expr, binds := col, 0
	for i := len(styles) - 1; i >= 0; i-- {
		switch styles[i] {
		case "hex":
			expr = "UNHEX(" + expr + ")"
		case "ip":
			expr = "INET6_NTOA(" + expr + ")"
		}
	}
	return expr, binds
}

func (MySQL) WriteExpr(ph func() string, colType string, styles []string) (string, int) {
	expr, binds := ph(), 1
	if colType == "point" {
		expr = "ST_PointFromText(" + expr + ")"
	}
	for _, s := range styles {
		switch s {
		case "hex":
			expr = "HEX(" + expr + ")"
		case "ip":
			expr = "INET6_ATON(" + expr + ")"
		}
	}
	return expr, binds
}
