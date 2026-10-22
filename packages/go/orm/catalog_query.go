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

// catalogWriteWords are the keywords that a read query never uses as a statement or clause: a query that contains one is
// refused before it runs. A write that still reached the database would fail in the read-only transaction.
var catalogWriteWords = map[string]bool{
	"INSERT": true, "UPDATE": true, "DELETE": true, "MERGE": true, "UPSERT": true, "CREATE": true, "DROP": true,
	"ALTER": true, "TRUNCATE": true, "RENAME": true, "GRANT": true, "REVOKE": true, "CALL": true, "DO": true,
	"INTO": true, "LOCK": true, "SHARE": true, "PROCEDURE": true, "LOAD": true, "COPY": true, "ATTACH": true,
	"DETACH": true, "PRAGMA": true, "VACUUM": true, "REINDEX": true, "ANALYZE": true,
}

// ReadOnlyQuery runs one read query (SELECT, WITH or VALUES) in a fresh read-only session. A query that writes, locks or
// has more than one statement fails with QUERY_READ_ONLY before it runs. Values come back as int64, float64, bool, string,
// time.Time, a copy of binary bytes, decimal text or nil for NULL; any other native type fails.
func (c *CatalogConnection) ReadOnlyQuery(ctx context.Context, query string, params []any, limits CatalogQueryLimits) (CatalogQueryResult, error) {
	args, maxRows, maxBytes, err := c.readOnlyArgs(query, params, limits)
	if err != nil {
		return CatalogQueryResult{}, err
	}
	return catalogRead(ctx, c, func(s *catalogSession) (CatalogQueryResult, error) {
		raw, err := s.queryRaw(query, args, maxRows, maxBytes)
		if err != nil {
			return CatalogQueryResult{}, err
		}
		rows, err := catalogConvert(raw, raw.types)
		if err != nil {
			return CatalogQueryResult{}, err
		}
		return CatalogQueryResult{Columns: raw.names, Rows: rows}, nil
	})
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

// catalogValidateReadOnly accepts one read query of at most catalogSQLBytes. It tokenizes the query so that keywords inside
// string literals, quoted identifiers and comments are not seen, and refuses a MySQL executable comment.
func catalogValidateReadOnly(query, dialect string) error {
	refused := catalogErr(catalogCodeReadOnly, "expected one supported non-locking read query")
	if query == "" || len(query) > catalogSQLBytes {
		return refused
	}
	words, ok := catalogWords(query, dialect)
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

// catalogWords returns the upper-cased words of a query and its semicolons. String literals, quoted identifiers and
// comments are skipped. It reports false for an unterminated literal or comment and for a MySQL executable comment.
func catalogWords(query, dialect string) ([]string, bool) {
	var words []string
	for i := 0; i < len(query); {
		c := query[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v':
			i++
		case c == '-' && strings.HasPrefix(query[i:], "--"):
			end := strings.IndexByte(query[i:], '\n')
			if end < 0 {
				return words, true
			}
			i += end + 1
		case c == '/' && strings.HasPrefix(query[i:], "/*"):
			if strings.HasPrefix(query[i:], "/*!") || strings.HasPrefix(query[i:], "/*M!") {
				return nil, false
			}
			end := strings.Index(query[i+2:], "*/")
			if end < 0 {
				return nil, false
			}
			i += end + 4
		case c == '\'' || c == '"' || c == '`':
			// MySQL reads backslash escapes inside string literals and double-quoted strings; other dialects do not.
			backslash := dialect == "mysql" && c != '`'
			next, ok := catalogSkipQuoted(query, i, c, backslash)
			if !ok {
				return nil, false
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
			i++
		default:
			i++
		}
	}
	return words, true
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
