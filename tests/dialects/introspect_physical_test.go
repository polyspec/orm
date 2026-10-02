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

	"github.com/polyspec/orm/engine/dbspec"
)

// countingQuerier는 introspection이 보낸 query 수를 센다.
type countingQuerier struct {
	q     dbspec.Querier
	count int
}

func (c *countingQuerier) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	c.count++
	return c.q.QueryContext(ctx, query, args...)
}

// roundTripSet은 한 database에 함께 적용하는 문서 집합이다.
type roundTripSet struct {
	id        string
	documents map[string]string
}

// roundTripSets는 tests/dbspec/ddl.json의 모든 case와 모든 schema 문서다.
func roundTripSets(t *testing.T) []roundTripSet {
	var out []roundTripSet
	raw, err := os.ReadFile(filepath.Join("..", "dbspec", "ddl.json"))
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
	for _, pattern := range schemaDocumentPatterns {
		paths, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		for _, path := range paths {
			text, diagnostics, err := dbspec.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if len(diagnostics) > 0 {
				t.Fatal(diagnostics)
			}
			name := strings.TrimSuffix(filepath.Base(path), ".dbs")
			out = append(out, roundTripSet{id: "schema_" + name, documents: map[string]string{name: text}})
		}
	}
	return out
}

// parseSet은 집합의 모든 문서를 parse한다.
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
		document, diagnostics := dbspec.Parse(s.documents[name], set)
		if len(diagnostics) > 0 {
			t.Fatalf("%s/%s: %v", s.id, name, diagnostics)
		}
		documents = append(documents, document)
	}
	return documents
}

// expectedSchemaText는 문서 집합의 schema text다. schema text는 문서를 나누는
// 방식과 무관하므로 introspect한 문서 하나의 schema text와 비교할 수 있다.
func expectedSchemaText(t *testing.T, documents []*dbspec.Document) string {
	manifest, diagnostics := dbspec.ManifestOf(documents)
	if len(diagnostics) > 0 {
		t.Fatal(diagnostics)
	}
	return manifest.SchemaText
}

// TestIntrospectRoundTrip은 각 집합을 렌더링해 적용하고 introspect한 문서의
// schema text가 원본과 같은지, 미지원 객체가 없는지, dialect마다 query 수가
// 집합의 table 수와 무관하게 같은지 확인한다.
func TestIntrospectRoundTrip(t *testing.T) {
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
			t.Run(probe.ID, func(t *testing.T) {
				begin := time.Now()
				t.Logf("start %s", probe.ID)
				_, err := runWithDeadline(servers, probe, index)
				elapsed := time.Since(begin).Round(time.Millisecond)
				if err != nil {
					t.Errorf("result %s: FAIL after %s: %v", probe.ID, elapsed, err)
					return
				}
				t.Logf("result %s: PASS after %s", probe.ID, elapsed)
			})
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

// TestIntrospectUnsupported는 tests/dbspec/introspect.json의 각 case를 그
// dialect의 빈 database에 적용하고, introspect한 문서와 미지원 목록을 확인한다.
func TestIntrospectUnsupported(t *testing.T) {
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV")
	}
	raw, err := os.ReadFile(filepath.Join("..", "dbspec", "introspect.json"))
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
			Unsupported [][3]string         `json:"unsupported"`
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
				// {schema}는 이 case의 database 또는 schema 이름이다.
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
			got := make([][3]string, len(unsupported))
			for i, u := range unsupported {
				got[i] = [3]string{u.Kind, u.Table, u.Name}
			}
			if !slices.Equal(got, c.Unsupported) {
				e.fail("unsupported differs\nwant %v\ngot  %+v", c.Unsupported, unsupported)
			}
		}}
		t.Run(probe.ID, func(t *testing.T) {
			begin := time.Now()
			t.Logf("start %s", probe.ID)
			_, err := runWithDeadline(servers, probe, index)
			elapsed := time.Since(begin).Round(time.Millisecond)
			if err != nil {
				t.Errorf("result %s: FAIL after %s: %v", probe.ID, elapsed, err)
				return
			}
			t.Logf("result %s: PASS after %s", probe.ID, elapsed)
		})
	}
}
