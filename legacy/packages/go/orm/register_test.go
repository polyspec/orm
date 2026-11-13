package orm

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/legacy/packages/go/internal/testdb"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// registerFixture is a set in which the external/member document of contracts/fixtures uses the tables of the external/core document.
// Since it uses an external document, a registration that reads the database performs introspection.
func registerFixture(t *testing.T) *Schema {
	t.Helper()
	m, diagnostics := runtimemodel.LoadDocumentSet(registerTexts(t, "external/member"), registerTexts(t, "external/core"))
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	return &Schema{Hash: m.ManifestHash, Text: m.ManifestText, External: m.ExternalText}
}

// registerTexts reads the dbspec documents of contracts/fixtures by name.
func registerTexts(t *testing.T, names ...string) []string {
	t.Helper()
	texts := make([]string, len(names))
	for i, name := range names {
		b, err := os.ReadFile(filepath.Join(testcase.LegacyRoot(), "contracts", "fixtures", name+".dbs"))
		if err != nil {
			t.Fatal(err)
		}
		texts[i] = string(b)
	}
	return texts
}

// onEachRegisterDatabase runs check on a connection to a new database of each kind, with the register fixture schema and the
// schema of the schema_install/note set.
func onEachRegisterDatabase(t *testing.T, check func(t *testing.T, db *DB, schema, other *Schema)) {
	t.Helper()
	schema := registerFixture(t)
	note, diagnostics := runtimemodel.LoadDocumentSet(registerTexts(t, "schema_install/note"), nil)
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	other := &Schema{Hash: note.ManifestHash, Text: note.ManifestText}
	for _, name := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(name, func(t *testing.T) {
			dsn := testdb.New(t, name)
			db, err := Connect(dsn, Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, db)
			check(t, db, schema, other)
		})
	}
}

// TestRegisterReusesEnginePerHash checks that a connection that registers two document sets with different manifest
// hashes plans each request with the engine of its own hash, and that registering a registered set again keeps its
// engine (docs/spec/schema.md SCH-17).
// Requirements: SCH-17, SCH-11.
func TestRegisterReusesEnginePerHash(t *testing.T) {
	testcase.Start(t, testcase.Database)
	onEachRegisterDatabase(t, func(t *testing.T, db *DB, schema, other *Schema) {
		for _, s := range []*Schema{schema, other, schema, other} {
			if err := db.Utils().Schema().Register(s); err != nil {
				t.Fatalf("register of %s: %v", s.Hash, err)
			}
		}
		memberEngine, err := db.engineFor(schema)
		if err != nil {
			t.Fatalf("the registered set is not planned: %v", err)
		}
		noteEngine, err := db.engineFor(other)
		if err != nil {
			t.Fatalf("the second registered set is not planned: %v", err)
		}
		if memberEngine == noteEngine || memberEngine.M.ManifestHash != schema.Hash || noteEngine.M.ManifestHash != other.Hash {
			t.Fatalf("hash-selected engines = %p (%s), %p (%s); want separate engines for %s and %s", memberEngine, memberEngine.M.ManifestHash, noteEngine, noteEngine.M.ManifestHash, schema.Hash, other.Hash)
		}
		again, err := db.engineFor(schema)
		if err != nil || again != memberEngine {
			t.Fatalf("re-registered set is planned by a new engine: %v", err)
		}
	})
}
