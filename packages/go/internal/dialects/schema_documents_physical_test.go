//go:build physical

package dialects

import (
	"fmt"
	"maps"
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

// schemaDocumentPatterns finds the dbspec documents that the clients and
// tests use as schemas; each document is one set with the documents of its
// directory that it uses (schemaDocumentSets).
var schemaDocumentPatterns = []string{
	filepath.Join(repoRoot, "contracts", "fixtures", "bench", "*.dbs"),
	filepath.Join(repoRoot, "contracts", "fixtures", "*.dbs"),
}

// schemaDocument is one schema document and its set: the texts by name of the
// document and of the documents of its directory that it uses.
type schemaDocument struct {
	name, path string
	documents  map[string]string
}

// schemaDocumentSets reads every schema document of schemaDocumentPatterns
// with dbspec.ReadFile, in path order, each with the documents it uses.
func schemaDocumentSets(t *testing.T) []schemaDocument {
	t.Helper()
	var out []schemaDocument
	for _, pattern := range schemaDocumentPatterns {
		paths, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		texts := map[string]string{}
		for _, path := range paths {
			text, diagnostics, err := dbspec.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if len(diagnostics) > 0 {
				t.Fatalf("%s: %v", path, diagnostics)
			}
			texts[strings.TrimSuffix(filepath.Base(path), ".dbs")] = text
		}
		for _, path := range paths {
			name := strings.TrimSuffix(filepath.Base(path), ".dbs")
			others := map[string]string{}
			for other, text := range texts {
				if other != name {
					others[other] = text
				}
			}
			document, _, diagnostics := dbspec.Parse(texts[name], others)
			if len(diagnostics) > 0 {
				t.Fatalf("%s: %v", path, diagnostics)
			}
			set := map[string]string{name: texts[name]}
			for _, u := range document.Uses {
				set[u.Document] = texts[u.Document]
			}
			out = append(out, schemaDocument{name: name, path: path, documents: set})
		}
	}
	if len(out) == 0 {
		t.Fatal("no schema document found")
	}
	return out
}

// TestSchemaDocumentsApply renders every schema document for MySQL,
// PostgreSQL and SQLite and applies the statements to its own database,
// schema or file of TEST_ENV.
func TestSchemaDocumentsApply(t *testing.T) {
	testcase.Group(t)
	mysqlDSN, postgresDSN := testDSNs(t)
	documents := schemaDocumentSets(t)
	servers := openTestServers(t, mysqlDSN, postgresDSN, "doc"+strconv.Itoa(os.Getpid()))
	started := time.Now()
	index := 0
	for _, sd := range documents {
		path, name := sd.path, sd.name
		var set []*dbspec.Document
		for _, other := range slices.Sorted(maps.Keys(sd.documents)) {
			rest := maps.Clone(sd.documents)
			delete(rest, other)
			document, _, diagnostics := dbspec.Parse(sd.documents[other], rest)
			if len(diagnostics) > 0 {
				t.Fatalf("%s/%s: %v", path, other, diagnostics)
			}
			set = append(set, document)
		}
		for _, db := range []string{"mysql", "postgres", "sqlite"} {
			statements, diagnostics := dbspec.Render(set, dbspec.Dialect(db))
			if len(diagnostics) > 0 {
				t.Errorf("%s on %s: %v", path, db, diagnostics)
				continue
			}
			probe := Probe{
				ID:   db + ".schema." + name,
				DB:   db,
				Fact: "the rendered statements of " + path + " apply",
				Run: func(e *Env) {
					e.Exec(connectionRules[db]...)
					e.Exec(statements...)
				},
			}
			index++
			t.Run(probe.ID, func(t *testing.T) {
				runProbeCase(t, servers, probe, index, fmt.Sprintf("%d statements", len(statements)))
			})
		}
	}
	t.Logf("summary: %d documents on three databases in %s", len(documents), time.Since(started).Round(time.Millisecond))
}
