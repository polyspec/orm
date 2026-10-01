package dbspec

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// ddlFile is tests/dbspec/ddl.json: document sets and the statements that
// Render writes for each dialect (docs/dialects.md "Rendered statements").
type ddlFile struct {
	Version int       `json:"version"`
	Cases   []ddlCase `json:"cases"`
}

type ddlCase struct {
	ID         string              `json:"id"`
	Documents  map[string][]string `json:"documents"`
	Statements map[string][]string `json:"statements"`
}

func loadDDL(t *testing.T) ddlFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(repositoryRoot(t), "tests", "dbspec", "ddl.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f ddlFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if f.Version != 1 || len(f.Cases) == 0 {
		t.Fatalf("tests/dbspec/ddl.json has version %d and %d cases", f.Version, len(f.Cases))
	}
	return f
}

// parseDDLSet parses every document of the case against the others.
func parseDDLSet(c ddlCase) ([]*Document, error) {
	names := make([]string, 0, len(c.Documents))
	for name := range c.Documents {
		names = append(names, name)
	}
	slices.Sort(names)
	var documents []*Document
	for _, name := range names {
		set := map[string]string{}
		for other, lines := range c.Documents {
			if other != name {
				set[other] = joinLines(lines, false)
			}
		}
		document, diagnostics := Parse(joinLines(c.Documents[name], false), set)
		if err := expectDocument(document, diagnostics); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		documents = append(documents, document)
	}
	return documents, nil
}

func TestRenderVectors(t *testing.T) {
	for _, c := range loadDDL(t).Cases {
		for _, dialect := range []Dialect{DialectMySQL, DialectPostgres, DialectSQLite} {
			t.Run(c.ID+"/"+string(dialect), func(t *testing.T) {
				runTimed(t, "render/"+c.ID+"/"+string(dialect), 5*time.Second, func() error {
					documents, err := parseDDLSet(c)
					if err != nil {
						return err
					}
					got, want := Render(documents, dialect), c.Statements[string(dialect)]
					for i := 0; i < max(len(got), len(want)); i++ {
						var g, w string
						if i < len(got) {
							g = got[i]
						}
						if i < len(want) {
							w = want[i]
						}
						if g != w {
							return fmt.Errorf("statement %d\n got: %s\nwant: %s", i+1, g, w)
						}
					}
					return nil
				})
			})
		}
	}
}
