package recipe

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/testcase"
)

// introspectConnectionRules are the statements that every client runs on a new connection (docs/spec/dbspec.md "Types",
// docs/spec/dialects.md "Foreign keys"), after the PostgreSQL notice level that keeps the test output plain.
var introspectConnectionRules = map[string][]string{
	"mysql":    {"SET time_zone = '+00:00'"},
	"postgres": {"SET client_min_messages = warning", "SET TimeZone = 'UTC'"},
	"sqlite":   {"PRAGMA foreign_keys = ON"},
}

// countingCatalog counts the catalog queries of the public Introspect.
type countingCatalog struct {
	querier dbspec.Querier
	count   int
}

// QueryContext counts one catalog query and sends it.
func (c *countingCatalog) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	c.count++
	return c.querier.QueryContext(ctx, query, args...)
}

// introspectVector is a case of tests/dbspec/ddl.json or tests/dbspec/introspect.json. Statements is a list only in the
// latter; the former holds the rendered statements of each dialect, which do not run here.
type introspectVector struct {
	ID          string              `json:"id"`
	Documents   map[string][]string `json:"documents"`
	Statements  json.RawMessage     `json:"statements"`
	Document    []string            `json:"document"`
	Unsupported [][]string          `json:"unsupported"`
}

// introspectSource is the documents of a step by name and its vector, which is empty for a step with paths.
func introspectSource(s databaseStep, dir string) (map[string]string, introspectVector, error) {
	texts := map[string]string{}
	if len(s.Paths) > 0 {
		for _, path := range s.Paths {
			text, diagnostics, err := dbspec.ReadFile(filepath.Join(dir, path))
			if err != nil {
				return nil, introspectVector{}, err
			}
			if len(diagnostics) > 0 {
				return nil, introspectVector{}, fmt.Errorf("%s: %v", path, diagnostics)
			}
			texts[strings.TrimSuffix(filepath.Base(path), ".dbs")] = text
		}
		return texts, introspectVector{}, nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, s.Vectors))
	if err != nil {
		return nil, introspectVector{}, err
	}
	var vectors struct {
		Cases []introspectVector `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		return nil, introspectVector{}, err
	}
	index := slices.IndexFunc(vectors.Cases, func(candidate introspectVector) bool { return candidate.ID == s.Case })
	if index < 0 {
		return nil, introspectVector{}, fmt.Errorf("the vectors have no case %s", s.Case)
	}
	vector := vectors.Cases[index]
	for name, lines := range vector.Documents {
		texts[name] = strings.Join(lines, "\n") + "\n"
	}
	return texts, vector, nil
}

// introspectParseSet parses every document of a set against the others, in name order.
func introspectParseSet(texts map[string]string) ([]*dbspec.Document, error) {
	names := make([]string, 0, len(texts))
	for name := range texts {
		names = append(names, name)
	}
	slices.Sort(names)
	documents := make([]*dbspec.Document, 0, len(names))
	for _, name := range names {
		others := map[string]string{}
		for other, text := range texts {
			if other != name {
				others[other] = text
			}
		}
		document, _, diagnostics := dbspec.Parse(texts[name], others)
		if len(diagnostics) > 0 {
			return nil, fmt.Errorf("%s: %v", name, diagnostics)
		}
		documents = append(documents, document)
	}
	return documents, nil
}

// introspectSchemaName is what {schema} of a vector statement names on the case database.
func introspectSchemaName(database, dsn string) (string, error) {
	switch database {
	case "mysql":
		parsed, err := url.Parse(dsn)
		if err != nil {
			return "", err
		}
		return strings.TrimPrefix(parsed.Path, "/"), nil
	case "postgres":
		return "public", nil
	default:
		return "main", nil
	}
}

// introspectStep runs one dbspec.introspect step: on one native connection of the case database, the connection rules, the
// rendered documents and the statements of the vector, then the public Introspect. A vector with a document compares the
// emitted document and the unsupported objects; any other requires none unsupported and the schema text of the source. It
// returns the number of catalog queries, which the expect of the database compares (DIA-133, DIA-198).
func introspectStep(s databaseStep, c *databaseContext) (int, error) {
	texts, vector, err := introspectSource(s, c.dir)
	if err != nil {
		return 0, err
	}
	documents, err := introspectParseSet(texts)
	if err != nil {
		return 0, err
	}
	rendered, diagnostics := dbspec.Render(documents, dbspec.Dialect(c.database))
	if len(diagnostics) > 0 {
		return 0, fmt.Errorf("render: %v", diagnostics)
	}
	// tests/dbspec/ddl.json holds the rendered statements of each dialect as an object; only a list runs.
	var extra []string
	if len(vector.Statements) > 0 && vector.Statements[0] == '[' {
		if err := json.Unmarshal(vector.Statements, &extra); err != nil {
			return 0, err
		}
	}
	schema, err := introspectSchemaName(c.database, c.dsn)
	if err != nil {
		return 0, err
	}
	raw := testdb.Open(c.t, c.database, c.dsn)
	defer testcase.Close(c.t, raw)
	raw.SetMaxOpenConns(1)
	for _, statement := range slices.Concat(introspectConnectionRules[c.database], rendered, extra) {
		if _, err := raw.ExecContext(c.ctx, strings.ReplaceAll(statement, "{schema}", schema)); err != nil {
			return 0, fmt.Errorf("%s: %w", statement, err)
		}
	}
	counter := &countingCatalog{querier: raw}
	document, unsupported, err := dbspec.Introspect(c.ctx, counter, dbspec.Dialect(c.database), "introspected")
	if err != nil {
		return 0, err
	}
	if vector.Document != nil {
		if got := dbspec.Emit(document); got != strings.Join(vector.Document, "\n")+"\n" {
			return 0, fmt.Errorf("the introspected document differs:\n%s", got)
		}
		if len(unsupported) != len(vector.Unsupported) {
			return 0, fmt.Errorf("unsupported objects %+v, want %v", unsupported, vector.Unsupported)
		}
		for index, want := range vector.Unsupported {
			item := unsupported[index]
			if !slices.Equal([]string{item.Kind, item.Table, item.Name}, want[:3]) {
				return 0, fmt.Errorf("unsupported objects %+v, want %v", unsupported, vector.Unsupported)
			}
			if item.Reason == "" {
				return 0, fmt.Errorf("the reason of %v is empty", want[:3])
			}
			if len(want) == 4 && !strings.Contains(item.Reason, want[3]) {
				return 0, fmt.Errorf("the reason of %v: %s, want rule %s", want[:3], item.Reason, want[3])
			}
		}
		return counter.count, nil
	}
	if len(unsupported) > 0 {
		return 0, fmt.Errorf("unsupported objects %+v", unsupported)
	}
	got, diagnostics := dbspec.ManifestOf([]*dbspec.Document{document})
	if len(diagnostics) > 0 {
		return 0, fmt.Errorf("the manifest of the result: %v", diagnostics)
	}
	want, diagnostics := dbspec.ManifestOf(documents)
	if len(diagnostics) > 0 {
		return 0, fmt.Errorf("the manifest of the source: %v", diagnostics)
	}
	if got.SchemaText != want.SchemaText {
		return 0, fmt.Errorf("the schema text differs:\n%s\nwant\n%s", got.SchemaText, want.SchemaText)
	}
	return counter.count, nil
}

// dbspecIntrospectRefusal runs dbspec.introspect_refusal: Introspect with a dialect of no reader, on an in-memory SQLite
// connection, panics with a message that names the dialect (DBS-174).
func dbspecIntrospectRefusal(s step) (any, error) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := db.Close(); closeErr != nil {
			fmt.Fprintln(os.Stderr, "close the SQLite memory connection:", closeErr)
		}
	}()
	return dialectRefusal(s.Dialect, func() {
		_, _, _ = dbspec.Introspect(context.Background(), db, dbspec.Dialect(s.Dialect), "introspected") //nolint:errcheck // The call panics.
	})
}

// introspectFailureStep introspects the empty case database with the catalog queries of another dialect: their failure is
// the error of the call (DIA-133).
func introspectFailureStep(s databaseStep, c *databaseContext) error {
	raw := testdb.Open(c.t, c.database, c.dsn)
	defer testcase.Close(c.t, raw)
	if _, _, err := dbspec.Introspect(c.ctx, raw, dbspec.Dialect(s.CatalogOf), "introspected"); err == nil {
		return fmt.Errorf("the %s catalog queries did not fail on %s", s.CatalogOf, c.database)
	}
	return nil
}
