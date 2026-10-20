package orm_test

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/orm"
)

// documentSchema is the orm.Schema of a dbspec document set. It builds the manifest text and
// manifestHash that generated code holds, in the same way for tests.
func documentSchema(t *testing.T, documents ...string) *orm.Schema {
	t.Helper()
	m, diagnostics := runtimemodel.LoadDocuments(documents)
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	return &orm.Schema{Hash: m.ManifestHash, Text: m.ManifestText}
}

// fixtureSchema is an orm.Schema built from the dbspec documents of contracts/fixtures.
func fixtureSchema(t *testing.T, names ...string) *orm.Schema {
	t.Helper()
	return documentSchema(t, fixtureTexts(t, names)...)
}

// fixtureTexts reads the dbspec documents of contracts/fixtures by name.
func fixtureTexts(t *testing.T, names []string) []string {
	t.Helper()
	documents := make([]string, len(names))
	for i, name := range names {
		text, diagnostics, err := dbspec.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", name+".dbs"))
		if err != nil {
			t.Fatal(err)
		}
		if len(diagnostics) > 0 {
			t.Fatal(diagnostics)
		}
		documents[i] = text
	}
	return documents
}

// externalSchema is an orm.Schema built from the owned document of contracts/fixtures and the external
// document (another set's document used through use). It carries the external text, as generated code does.
func externalSchema(t *testing.T, owned, external []string) *orm.Schema {
	t.Helper()
	m, diagnostics := runtimemodel.LoadDocumentSet(fixtureTexts(t, owned), fixtureTexts(t, external))
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	return &orm.Schema{Hash: m.ManifestHash, Text: m.ManifestText, External: m.ExternalText}
}

// rowEntity is the entity of a hand-written model that holds column values by name.
func rowEntity(name string, s *orm.Schema, columns ...string) *orm.Entity {
	return &orm.Entity{
		Name:   name,
		Schema: s,
		New: func(c *orm.Core) orm.Model {
			r := &keywordRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) (bool, error) {
			for _, c := range columns {
				if c == name {
					row, err := asErr[*keywordRow](m)
					if err != nil {
						return false, err
					}
					row.vals[name] = v
					return true, nil
				}
			}
			return false, nil
		},
		Value: func(m orm.Model, name string) (any, bool) {
			row, err := asErr[*keywordRow](m)
			if err != nil {
				panic(err)
			}
			v, ok := row.vals[name]
			return v, ok
		},
		Collect: func(keys []orm.Key, items map[orm.Key]*orm.Core, fetched map[orm.Key]any) any {
			return orm.CollectOf[*keywordRow](keys, items, fetched)
		},
	}
}

// as returns v as a T; a value of another type fails the test.
func as[T any](t testing.TB, v any) T {
	t.Helper()
	out, err := asErr[T](v)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// mustAs returns v as a T, and panics when v is another type; it serves the callbacks that have no test.
func mustAs[T any](v any) T {
	out, err := asErr[T](v)
	if err != nil {
		panic(err)
	}
	return out
}

// asErr returns v as a T, or an error when v is another type.
func asErr[T any](v any) (T, error) {
	out, ok := v.(T)
	if !ok {
		var zero T
		return zero, fmt.Errorf("value is %T, not %T", v, zero)
	}
	return out, nil
}
