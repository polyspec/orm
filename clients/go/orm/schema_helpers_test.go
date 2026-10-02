package orm_test

import (
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/engine/runtimemodel"
)

// documentSchema은 dbspec document set의 orm.Schema다. generated code가 품는
// manifest text와 manifestHash를 test에서 같은 방식으로 만든다.
func documentSchema(t *testing.T, documents ...string) *orm.Schema {
	t.Helper()
	m, diagnostics := runtimemodel.LoadDocuments(documents)
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	return &orm.Schema{Hash: m.ManifestHash, Text: m.ManifestText}
}

// fixtureSchema은 contracts/fixtures의 dbspec document로 만든 orm.Schema다.
func fixtureSchema(t *testing.T, names ...string) *orm.Schema {
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
	return documentSchema(t, documents...)
}

// rowEntity는 이름으로 column 값을 담는 손으로 쓴 model의 entity다.
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
					m.(*keywordRow).vals[name] = v
					return true, nil
				}
			}
			return false, nil
		},
		Value: func(m orm.Model, name string) (any, bool) {
			v, ok := m.(*keywordRow).vals[name]
			return v, ok
		},
		Collect: func(keys []orm.Key, items map[orm.Key]*orm.Core, fetched map[orm.Key]any) any {
			return orm.CollectOf[*keywordRow](keys, items, fetched)
		},
	}
}
