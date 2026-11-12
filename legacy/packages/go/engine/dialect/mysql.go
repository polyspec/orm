package dialect

import (
	"fmt"
	"strings"
)

// MySQL is the primary dialect. Style expressions are defined to preserve the
// stored byte representation
// AES and hex are host-side; IP packing remains SQL-side.
type MySQL struct {
	// MariaDB is set when the server of the connection is MariaDB (DIA-201), which renders the one clause that has no common
	// form on the two servers (DIA-209).
	MariaDB bool
}

func (MySQL) Name() string                            { return "mysql" }
func (MySQL) Quote(ident string) string               { return QuoteWith("`", ident) }
func (MySQL) Placeholder(int) string                  { return "?" }
func (MySQL) Limit(offset, count int) string          { return fmt.Sprintf(" LIMIT %d, %d", offset, count) }
func (MySQL) LimitParams(offset, count string) string { return " LIMIT " + offset + ", " + count }
func (MySQL) ForceIndex(name string) string           { return " FORCE INDEX (" + QuoteWith("`", name) + ")" }
func (MySQL) InsertReturningID() bool                 { return false }
func (MySQL) Now(precision int) string {
	if precision > 0 {
		return fmt.Sprintf("CURRENT_TIMESTAMP(%d)", precision)
	}
	return "CURRENT_TIMESTAMP"
}
func (MySQL) HostNow() bool                         { return false }
func (MySQL) ClockOperand(col string, _ int) string { return col }
func (MySQL) ReadTime(col string, _ int) string     { return "CAST(" + col + " AS CHAR)" }
func (MySQL) WriteTime(ph string) string            { return ph }

// RowLock renders a shared lock as LOCK IN SHARE MODE, which both servers read, since MariaDB has no FOR SHARE (DIA-209,
// probes mysql.lock.share_clause and mariadb.lock.share_clause). A shared NOWAIT lock has no common form: MySQL takes
// NOWAIT after FOR SHARE alone and MariaDB after LOCK IN SHARE MODE alone.
func (d MySQL) RowLock(mode string) (string, bool) {
	switch mode {
	case "share":
		return " LOCK IN SHARE MODE", true
	case "share_nowait":
		if d.MariaDB {
			return " LOCK IN SHARE MODE NOWAIT", true
		}
		return " FOR SHARE NOWAIT", true
	}
	return rowLock(mode)
}

// AES is host-side so row version metadata can select the key before decode,
// and hex is host-side so every dialect writes and reads the same text
// (docs/spec/dialects.md, Rules that keep the three databases identical). ip
// remains SQL-side: INET6_ATON packs the address into the binary column.
func (MySQL) HandlesStyle(s string) bool { return s == "ip" }

func (MySQL) DecodesStyle(s string) bool { return s == "ip" }

// Like folds the ASCII letters of both operands to lower case and leaves every other character as it is, so
// LIKE under the binary collation utf8mb4_0900_bin matches as PostgreSQL ILIKE under "C" and SQLite LIKE do
// (the probes mysql.like.binary_collation_case_sensitive and mysql.like.ascii_fold_replace).
func (MySQL) Like(col, ph string) string { return asciiLower(col) + " LIKE " + asciiLower(ph) }

// asciiLower wraps x in 26 nested REPLACE calls, one for each of A to Z with its lower case. LOWER and every
// _ci collation fold beyond ASCII, so they would not give the other databases' result.
func asciiLower(x string) string {
	var b strings.Builder
	b.WriteString(strings.Repeat("REPLACE(", 26))
	b.WriteString(x)
	for c := 'A'; c <= 'Z'; c++ {
		fmt.Fprintf(&b, ", '%c', '%c')", c, c+'a'-'A')
	}
	return b.String()
}

func (MySQL) RowNumber(partition, orderBy string) string {
	s := "ROW_NUMBER() OVER (PARTITION BY " + partition
	if orderBy != "" {
		s += " ORDER BY " + orderBy
	}
	return s + ")"
}

// RestartIdentity: InnoDB sets AUTO_INCREMENT to the largest column value if that is at most it, and
// otherwise to that largest value plus 1; since 1 is always the value after the largest key, DDL commits an open
// transaction.
func (MySQL) InsertValue(expr, _ string) string { return expr }

func (MySQL) RestartIdentity(table, _ string) string {
	return "ALTER TABLE " + QuoteWith("`", table) + " AUTO_INCREMENT = 1"
}

func (MySQL) Upsert(_ []string, assigns string) string {
	return " ON DUPLICATE KEY UPDATE " + assigns
}

// ReadExpr applies SQL-side stages. AES is handled by the executor so it can
// select the key from the row's version metadata.
func (MySQL) ReadExpr(col string, styles []string) string {
	expr := col
	for i := len(styles) - 1; i >= 0; i-- {
		if styles[i] == "ip" {
			expr = "INET6_NTOA(" + expr + ")"
		}
	}
	return expr
}

func (MySQL) WriteExpr(ph string, styles []string) string {
	expr := ph
	for _, s := range styles {
		if s == "ip" {
			expr = "INET6_ATON(" + expr + ")"
		}
	}
	return expr
}

func (MySQL) ReadUUID(col string) string { return col }
func (MySQL) WriteUUID(ph string) string { return ph }
