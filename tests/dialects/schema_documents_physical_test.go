//go:build physical

package dialects

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/internal/testcase"
)

// schemaDocumentPatterns finds the dbspec documents that the clients and
// tests use as schemas; each document is one set.
var schemaDocumentPatterns = []string{
	filepath.Join("..", "..", "schema", "*.dbs"),
	filepath.Join("..", "..", "contracts", "fixtures", "*.dbs"),
}

// TestSchemaDocumentsApply renders every schema document for MySQL,
// PostgreSQL and SQLite and applies the statements to its own database,
// schema or file of TEST_ENV.
func TestSchemaDocumentsApply(t *testing.T) {
	testcase.Group(t)
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV")
	}
	var paths []string
	for _, pattern := range schemaDocumentPatterns {
		found, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		paths = append(paths, found...)
	}
	if len(paths) == 0 {
		t.Fatal("no schema document found")
	}
	connect, cancel := context.WithTimeout(context.Background(), probeDeadline)
	servers, err := OpenServers(connect, mysqlDSN, postgresDSN, t.TempDir(), "doc"+strconv.Itoa(os.Getpid()))
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
	for _, path := range paths {
		text, diagnostics, err := dbspec.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if len(diagnostics) > 0 {
			t.Errorf("%s: %v", path, diagnostics)
			continue
		}
		document, diagnostics := dbspec.Parse(text, nil)
		if len(diagnostics) > 0 {
			t.Errorf("%s: %v", path, diagnostics)
			continue
		}
		name := strings.TrimSuffix(filepath.Base(path), ".dbs")
		for _, db := range []string{"mysql", "postgres", "sqlite"} {
			statements, diagnostics := dbspec.Render([]*dbspec.Document{document}, dbspec.Dialect(db))
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
	t.Logf("summary: %d documents on three databases in %s", len(paths), time.Since(started).Round(time.Millisecond))
}
