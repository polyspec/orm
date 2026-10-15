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
func (MySQL) Now(precision int) string {
	if precision > 0 {
		return fmt.Sprintf("CURRENT_TIMESTAMP(%d)", precision)
	}
	return "CURRENT_TIMESTAMP"
}
func (MySQL) HostNow() bool                     { return false }
func (MySQL) ReadTime(col string, _ int) string { return "CAST(" + col + " AS CHAR)" }
func (MySQL) WriteTime(ph string) string        { return ph }
func (MySQL) RowLock(mode string) (string, bool) {
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

// AES is host-side so row version metadata can select the key before decode.
// hex and ip remain SQL-side because they do not depend on a secret.
func (MySQL) HandlesStyle(s string) bool { return s == "hex" || s == "ip" }

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

// RestartIdentity: InnoDB는 AUTO_INCREMENT를 column의 가장 큰 값 이하로 정하면 가장
// 큰 값에 1을 더한 값으로 정하므로 1은 언제나 가장 큰 key 다음이다. DDL이므로 열린
// transaction을 commit한다.
func (MySQL) RestartIdentity(table, _ string) string {
	return "ALTER TABLE " + QuoteWith("`", table) + " AUTO_INCREMENT = 1"
}

func (MySQL) Upsert(_ []string, assigns string) string {
	return " ON DUPLICATE KEY UPDATE " + assigns
}

// ReadExpr applies SQL-side stages. AES is handled by the executor so it can
// select the key from the row's version metadata.
func (MySQL) ReadExpr(col string, styles []string, ph func() string) (string, int) {
	expr, binds := col, 0
	for i := len(styles) - 1; i >= 0; i-- {
		if styles[i] == "ip" {
			expr = "INET6_NTOA(" + expr + ")"
		}
	}
	return expr, binds
}

func (MySQL) WriteExpr(ph func() string, styles []string) (string, int) {
	expr, binds := ph(), 1
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
