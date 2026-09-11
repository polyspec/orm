package dialect

import (
	"fmt"
	"strings"
)

// MySQL is the primary dialect. Style expressions match compatibility byte-for-byte
// (HEX(AES_ENCRYPT(?, ?)), AES_DECRYPT(UNHEX(col), ?), INET6_ATON/NTOA).
type MySQL struct{}

func (MySQL) Name() string                   { return "mysql" }
func (MySQL) Quote(ident string) string      { return QuoteWith("`", ident) }
func (MySQL) Placeholder(int) string         { return "?" }
func (MySQL) Limit(offset, count int) string { return fmt.Sprintf(" LIMIT %d, %d", offset, count) }
func (MySQL) ForceIndex(name string) string  { return " FORCE INDEX (" + QuoteWith("`", name) + ")" }
func (MySQL) InsertReturningID() bool        { return false }
func (MySQL) Now() string                    { return "CURRENT_TIMESTAMP" }

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

// FulltextValue reproduces compatibility: "foo bar" → "+foo +bar*" in boolean mode.
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

// ReadExpr: styles are applied on write in order and undone on read in
// reverse. Only SQL-side stages appear here; app-side stages (gz/json/…)
// are the executor's job.
func (MySQL) ReadExpr(col string, styles []string, ph func() string) (string, int) {
	expr, binds := col, 0
	for i := len(styles) - 1; i >= 0; i-- {
		switch styles[i] {
		case "hex":
			expr = "UNHEX(" + expr + ")"
		case "aes":
			expr = "AES_DECRYPT(" + expr + ", " + ph() + ")"
			binds++
		case "ip":
			expr = "INET6_NTOA(" + expr + ")"
		}
	}
	return expr, binds
}

func (MySQL) WriteExpr(ph func() string, styles []string) (string, int) {
	expr, binds := ph(), 1
	for _, s := range styles {
		switch s {
		case "aes":
			expr = "AES_ENCRYPT(" + expr + ", " + ph() + ")"
			binds++
		case "hex":
			expr = "HEX(" + expr + ")"
		case "ip":
			expr = "INET6_ATON(" + expr + ")"
		}
	}
	return expr, binds
}
