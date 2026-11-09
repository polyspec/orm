package orm

import (
	"context"
	"strings"
)

// CatalogQueryLimits bounds a read-only query. A zero field takes its default: 100000 rows and 64 MiB of values. A
// result over a limit fails; it is never truncated.
type CatalogQueryLimits struct {
	MaxRows  int
	MaxBytes int
}

// CatalogQueryResult is the result of a read-only query: its column names and its rows of typed values.
type CatalogQueryResult struct {
	Columns []string
	Rows    [][]any
}

func catalogReadRows(s *catalogSession, metadata CatalogTableMetadata, query string, args []any) ([][]any, error) {
	raw, err := s.queryRaw(query, args, 2, catalogPageBytes)
	if err != nil {
		return nil, err
	}
	if err := catalogSameNames(raw.names, metadata.Columns); err != nil {
		return nil, err
	}
	return s.convertDescribed(raw, metadata)
}

// catalogWriteWords are the keywords that a read query never uses as a statement or clause: a query that contains one is
// refused before it runs. A write that still reached the database would fail in the read-only transaction.
var catalogWriteWords = map[string]bool{
	"INSERT": true, "UPDATE": true, "DELETE": true, "MERGE": true, "UPSERT": true, "CREATE": true, "DROP": true,
	"ALTER": true, "TRUNCATE": true, "RENAME": true, "GRANT": true, "REVOKE": true, "CALL": true, "DO": true,
	"INTO": true, "LOCK": true, "SHARE": true, "PROCEDURE": true, "LOAD": true, "COPY": true, "ATTACH": true,
	"DETACH": true, "PRAGMA": true, "VACUUM": true, "REINDEX": true, "ANALYZE": true,
}

// ReadOnlyQuery runs one read query (SELECT, WITH or VALUES) in a fresh read-only session. A query that writes, locks or
// has more than one statement fails with QUERY_READ_ONLY before it runs. Values come back as int64, uint64 (a MySQL
// unsigned value), float64, bool, string, a copy of binary bytes, decimal text or nil for NULL. On MySQL and PostgreSQL each
// value follows the catalog value rules (docs/spec/interfaces.md, "Catalog value rules") as in ReadOnlyGridQuery: a date,
// time or datetime is the text of its grid cell (INT-153), a float of either width a float64 (INT-183), and a value that a
// rule refuses fails with CODE: column n: text.
func (c *CatalogConnection) ReadOnlyQuery(ctx context.Context, query string, params []any, limits CatalogQueryLimits) (CatalogQueryResult, error) {
	args, maxRows, maxBytes, err := c.readOnlyArgs(query, params, limits)
	if err != nil {
		return CatalogQueryResult{}, err
	}
	return catalogRead(ctx, c, func(s *catalogSession) (CatalogQueryResult, error) {
		statement, columns, err := s.storedQuery(query, args)
		if err != nil {
			return CatalogQueryResult{}, err
		}
		// Each value is converted as it is read, and the budget counts the converted value (INT-115).
		var values []any
		convert := newCatalogCells(s)
		raw, err := s.querySized(statement, args, maxRows, maxBytes, func(value any, native string, column int) (int, error) {
			v, err := catalogQueryValue(convert, value, native, column)
			if err != nil {
				return 0, err
			}
			values = append(values, v)
			return catalogSize(v), nil
		})
		if err != nil {
			return CatalogQueryResult{}, err
		}
		rows := make([][]any, 0, len(raw.rows))
		for i := range raw.rows {
			width := len(raw.names)
			rows = append(rows, values[i*width:(i+1)*width])
		}
		if columns == nil {
			columns = raw.names
		}
		return CatalogQueryResult{Columns: columns, Rows: rows}, nil
	})
}

// catalogQueryValue is the value of one driver value of a read query: the Go value of its grid cell, a float widened to a
// float64. On SQLite that is the value of its storage class, a stored date, time or datetime its text (INT-153).
func catalogQueryValue(convert *catalogCells, value any, native string, column int) (any, error) {
	cell, err := convert.cell(value, native, column)
	if err != nil {
		return nil, err
	}
	v := catalogCellValue(cell)
	if narrow, isFloat32 := v.(float32); isFloat32 {
		return float64(narrow), nil
	}
	return v, nil
}

// readOnlyArgs checks a read query, its limits and its parameters, and returns the parameters with the row and byte
// budgets of the query, the defaults filled in for zero.
func (c *CatalogConnection) readOnlyArgs(query string, params []any, limits CatalogQueryLimits) ([]any, int, int, error) {
	if err := catalogValidateReadOnly(query, c.dialect); err != nil {
		return nil, 0, 0, err
	}
	if limits.MaxRows < 0 || limits.MaxBytes < 0 {
		return nil, 0, 0, catalogErr("QUERY_LIMIT_INVALID", "limits must not be negative")
	}
	maxRows, maxBytes := limits.MaxRows, limits.MaxBytes
	if maxRows == 0 {
		maxRows = catalogDefaultRows
	}
	if maxBytes == 0 {
		maxBytes = catalogDefaultBytes
	}
	args, err := catalogParams(params)
	if err != nil {
		return nil, 0, 0, err
	}
	return args, maxRows, maxBytes, nil
}

// catalogValidateReadOnly accepts one read query of any length. It tokenizes the query so that keywords inside
// string literals, quoted identifiers and comments are not seen, and refuses a MySQL executable comment.
func catalogValidateReadOnly(query, dialect string) error {
	refused := catalogErr(catalogCodeReadOnly, "expected one supported non-locking read query")
	if query == "" {
		return refused
	}
	words, _, ok := catalogWords(query, dialect)
	if !ok || len(words) == 0 {
		return refused
	}
	switch words[0] {
	case "SELECT", "WITH", "VALUES":
	default:
		return refused
	}
	for i, word := range words {
		if word == ";" {
			// Only one trailing semicolon is allowed; anything after it would be a second statement.
			if i != len(words)-1 {
				return refused
			}
			continue
		}
		if catalogWriteWords[word] {
			return refused
		}
	}
	return nil
}

// catalogWords returns the upper-cased words of a query and its semicolons, and the byte offset of its last semicolon or -1.
// String literals, quoted identifiers and comments are skipped. It reports false for an unterminated literal or comment and
// for a MySQL executable comment.
func catalogWords(query, dialect string) ([]string, int, bool) {
	var words []string
	semicolon := -1
	for i := 0; i < len(query); {
		c := query[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v':
			i++
		case c == '-' && strings.HasPrefix(query[i:], "--"):
			end := strings.IndexByte(query[i:], '\n')
			if end < 0 {
				return words, semicolon, true
			}
			i += end + 1
		case c == '/' && strings.HasPrefix(query[i:], "/*"):
			if strings.HasPrefix(query[i:], "/*!") || strings.HasPrefix(query[i:], "/*M!") {
				return nil, -1, false
			}
			end := strings.Index(query[i+2:], "*/")
			if end < 0 {
				return nil, -1, false
			}
			i += end + 4
		case c == '\'' || c == '"' || c == '`':
			// MySQL reads backslash escapes inside string literals and double-quoted strings; other dialects do not.
			backslash := dialect == "mysql" && c != '`'
			next, ok := catalogSkipQuoted(query, i, c, backslash)
			if !ok {
				return nil, -1, false
			}
			i = next
		case c == '_' || isASCIILetter(c):
			j := i
			for j < len(query) && (query[j] == '_' || query[j] == '$' || isASCIILetter(query[j]) || isASCIIDigit(query[j])) {
				j++
			}
			words = append(words, strings.ToUpper(query[i:j]))
			i = j
		case isASCIIDigit(c):
			j := i
			for j < len(query) && (query[j] == '.' || query[j] == '_' || isASCIILetter(query[j]) || isASCIIDigit(query[j])) {
				j++
			}
			i = j
		case c == ';':
			words = append(words, ";")
			semicolon = i
			i++
		default:
			i++
		}
	}
	return words, semicolon, true
}

// catalogSkipQuoted returns the index after the literal or identifier that starts at start, with the doubled quote mark
// and, when backslash is set, backslash escapes read as one character.
func catalogSkipQuoted(query string, start int, quote byte, backslash bool) (int, bool) {
	for i := start + 1; i < len(query); i++ {
		switch {
		case backslash && query[i] == '\\':
			i++
		case query[i] == quote:
			if i+1 < len(query) && query[i+1] == quote {
				i++
				continue
			}
			return i + 1, true
		}
	}
	return 0, false
}

func isASCIILetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

func isASCIIDigit(c byte) bool { return c >= '0' && c <= '9' }
