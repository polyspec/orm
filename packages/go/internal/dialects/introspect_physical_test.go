//go:build physical

package dialects

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/testcase"
)

// countingQuerier counts the number of queries that introspection sent.
type countingQuerier struct {
	q     dbspec.Querier
	count int
}

func (c *countingQuerier) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	c.count++
	return c.q.QueryContext(ctx, query, args...)
}

// roundTripSet is the document set applied together to one database.
type roundTripSet struct {
	id        string
	documents map[string]string
}

// roundTripSets is every case of tests/dbspec/ddl.json and every schema document.
func roundTripSets(t *testing.T) []roundTripSet {
	var out []roundTripSet
	raw, err := os.ReadFile(filepath.Join(repoRoot, "tests", "dbspec", "ddl.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			ID        string              `json:"id"`
			Documents map[string][]string `json:"documents"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, c := range vectors.Cases {
		set := roundTripSet{id: "ddl_" + strings.ReplaceAll(c.ID, "-", "_"), documents: map[string]string{}}
		for name, lines := range c.Documents {
			set.documents[name] = strings.Join(lines, "\n") + "\n"
		}
		out = append(out, set)
	}
	for _, sd := range schemaDocumentSets(t) {
		out = append(out, roundTripSet{id: "schema_" + sd.name, documents: sd.documents})
	}
	return out
}

// parseSet parses every document in the set.
func parseSet(t *testing.T, s roundTripSet) []*dbspec.Document {
	var documents []*dbspec.Document
	names := make([]string, 0, len(s.documents))
	for name := range s.documents {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		set := map[string]string{}
		for other, text := range s.documents {
			if other != name {
				set[other] = text
			}
		}
		document, _, diagnostics := dbspec.Parse(s.documents[name], set)
		if len(diagnostics) > 0 {
			t.Fatalf("%s/%s: %v", s.id, name, diagnostics)
		}
		documents = append(documents, document)
	}
	return documents
}

// expectedSchemaText is the schema text of the document set. The schema text is independent
// of how the documents are split, so it can be compared with the schema text of one introspected document.
func expectedSchemaText(t *testing.T, documents []*dbspec.Document) string {
	manifest, diagnostics := dbspec.ManifestOf(documents)
	if len(diagnostics) > 0 {
		t.Fatal(diagnostics)
	}
	return manifest.SchemaText
}

// TestIntrospectRoundTrip renders and applies each set, and checks that the schema text of the introspected documents
// equals the original, that there are no unsupported objects, and that the query count per dialect
// is the same regardless of the table count of the set.
func TestIntrospectRoundTrip(t *testing.T) {
	testcase.Group(t)
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV")
	}
	connect, cancel := context.WithTimeout(context.Background(), probeDeadline)
	servers, err := OpenServers(connect, mysqlDSN, postgresDSN, t.TempDir(), "rt"+strconv.Itoa(os.Getpid()))
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := servers.Close(); err != nil {
			t.Error(err)
		}
	})
	started := time.Now()
	index := 0
	sets := roundTripSets(t)
	queries := map[string]map[int][]string{}
	for _, s := range sets {
		documents := parseSet(t, s)
		want := expectedSchemaText(t, documents)
		for _, db := range []string{"mysql", "postgres", "sqlite"} {
			statements, diagnostics := dbspec.Render(documents, dbspec.Dialect(db))
			if len(diagnostics) > 0 {
				t.Fatalf("%s: %v", s.id, diagnostics)
			}
			probe := Probe{ID: db + ".introspect." + s.id, DB: db, Fact: "introspection restores " + s.id, Run: func(e *Env) {
				e.Exec(connectionRules[db]...)
				e.Exec(statements...)
				if e.Err != nil {
					return
				}
				counter := &countingQuerier{q: e.Conn}
				document, unsupported, err := dbspec.Introspect(e.Ctx, counter, dbspec.Dialect(db), "introspected")
				if err != nil {
					e.fail("introspect: %v", err)
					return
				}
				if queries[db] == nil {
					queries[db] = map[int][]string{}
				}
				queries[db][counter.count] = append(queries[db][counter.count], fmt.Sprintf("%s (%d tables)", s.id, len(document.Tables)))
				if len(unsupported) > 0 {
					e.fail("unsupported: %+v", unsupported)
					return
				}
				manifest, diagnostics := dbspec.ManifestOf([]*dbspec.Document{document})
				if len(diagnostics) > 0 {
					e.fail("manifest: %v", diagnostics)
					return
				}
				if manifest.SchemaText != want {
					e.fail("schema text differs\n--- want\n%s--- got\n%s", want, manifest.SchemaText)
				}
			}}
			index++
			t.Run(probe.ID, func(t *testing.T) { runProbeCase(t, servers, probe, index, "") })
		}
	}
	for db, counts := range queries {
		if len(counts) != 1 {
			t.Errorf("%s: introspection query counts differ between sets: %v", db, counts)
		}
		for count := range counts {
			t.Logf("%s: %d queries for every set", db, count)
		}
	}
	t.Logf("summary: %d sets on three databases in %s", len(sets), time.Since(started).Round(time.Millisecond))
}

// TestIntrospectUnsupported applies each case of tests/dbspec/introspect.json
// to an empty database of the dialect, and checks the introspected document and the unsupported list.
func TestIntrospectUnsupported(t *testing.T) {
	testcase.Group(t)
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV")
	}
	raw, err := os.ReadFile(filepath.Join(repoRoot, "tests", "dbspec", "introspect.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			ID          string              `json:"id"`
			Dialect     string              `json:"dialect"`
			Documents   map[string][]string `json:"documents"`
			Statements  []string            `json:"statements"`
			Document    []string            `json:"document"`
			Unsupported [][]string          `json:"unsupported"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	connect, cancel := context.WithTimeout(context.Background(), probeDeadline)
	servers, err := OpenServers(connect, mysqlDSN, postgresDSN, t.TempDir(), "iu"+strconv.Itoa(os.Getpid()))
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := servers.Close(); err != nil {
			t.Error(err)
		}
	})
	for index, c := range vectors.Cases {
		set := roundTripSet{id: c.ID, documents: map[string]string{}}
		for name, lines := range c.Documents {
			set.documents[name] = strings.Join(lines, "\n") + "\n"
		}
		statements, diagnostics := dbspec.Render(parseSet(t, set), dbspec.Dialect(c.Dialect))
		if len(diagnostics) > 0 {
			t.Fatalf("%s: %v", c.ID, diagnostics)
		}
		want := strings.Join(c.Document, "\n") + "\n"
		probe := Probe{ID: c.Dialect + ".introspect." + c.ID, DB: c.Dialect, Fact: "introspection reports " + c.ID, Run: func(e *Env) {
			e.Exec(connectionRules[c.Dialect]...)
			e.Exec(statements...)
			for _, statement := range c.Statements {
				// {schema} is the database or schema name of this case.
				e.Exec(strings.ReplaceAll(statement, "{schema}", e.Name))
			}
			if e.Err != nil {
				return
			}
			document, unsupported, err := dbspec.Introspect(e.Ctx, e.Conn, dbspec.Dialect(c.Dialect), "introspected")
			if err != nil {
				e.fail("introspect: %v", err)
				return
			}
			if got := dbspec.Emit(document); got != want {
				e.fail("document differs\n--- want\n%s--- got\n%s", want, got)
			}
			got := make([][]string, len(unsupported))
			for i, u := range unsupported {
				got[i] = []string{u.Kind, u.Table, u.Name}
			}
			want := make([][]string, len(c.Unsupported))
			for i, w := range c.Unsupported {
				want[i] = w[:3]
			}
			if !slices.EqualFunc(got, want, func(a, b []string) bool { return slices.Equal(a, b) }) {
				e.fail("unsupported differs\nwant %v\ngot  %+v", c.Unsupported, unsupported)
				return
			}
			// The fourth element is a rule the reason must contain. If absent, the reason is not compared.
			for i, w := range c.Unsupported {
				if len(w) == 4 && !strings.Contains(unsupported[i].Reason, w[3]) {
					e.fail("reason of %s %s %s differs\nwant rule %q\ngot  %q", w[0], w[1], w[2], w[3], unsupported[i].Reason)
				}
			}
		}}
		// The subtest is the case id of tests/dbspec/introspect.json; the probe keeps its dialect-qualified id.
		t.Run(c.ID, func(t *testing.T) { runProbeCase(t, servers, probe, index, "") })
	}
}
