package orm_test

import (
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/packages/orm-go/orm"
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

// externalSchema은 contracts/fixtures의 소유 문서와 외부 문서(use로 쓰는 다른 set의
// 문서)로 만든 orm.Schema다. generated code처럼 external text를 싣는다.
func externalSchema(t *testing.T, owned, external []string) *orm.Schema {
	t.Helper()
	paths := func(names []string) []string {
		out := make([]string, len(names))
		for i, name := range names {
			out[i] = filepath.Join("..", "..", "..", "contracts", "fixtures", name+".dbs")
		}
		return out
	}
	m, err := runtimemodel.LoadFileSet(paths(owned), paths(external))
	if err != nil {
		t.Fatal(err)
	}
	return &orm.Schema{Hash: m.ManifestHash, Text: m.ManifestText, External: m.ExternalText}
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
