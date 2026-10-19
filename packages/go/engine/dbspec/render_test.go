package dbspec

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

// ddlFile is tests/dbspec/ddl.json. It holds the document set and the statements that Render writes per dialect
// (docs/spec/dialects.md "Rendered statements").
type ddlFile struct {
	Cases []ddlCase
}

type ddlCase struct {
	ID         string
	Documents  map[string][]string
	Statements map[string][]string
}

func loadDDL(t *testing.T) ddlFile {
	t.Helper()
	r, object := readVectorFile(t, "ddl.json")
	f, err := decodeDDLVectors(r, object)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// decodeDDLVectors reads the cases and fields of ddl.json, and rejects any value that is missing or of another type
// along with its location.
func decodeDDLVectors(r vectorReader, object map[string]any) (ddlFile, error) {
	var f ddlFile
	if err := r.version(object); err != nil {
		return f, err
	}
	var err error
	f.Cases, err = vectorCases(r, object, "cases", func(c map[string]any, location, id string) (ddlCase, error) {
		d := ddlCase{ID: id}
		var err error
		if d.Documents, err = r.linesMap(c, location, "documents"); err != nil {
			return d, err
		}
		d.Statements, err = r.linesMap(c, location, "statements")
		return d, err
	})
	return f, err
}

// parseDDLSet parses all documents of the case against the other documents.
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
		document, _, diagnostics := Parse(joinLines(c.Documents[name], false), set)
		if err := expectDocument(document, diagnostics); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		documents = append(documents, document)
	}
	return documents, nil
}

func TestRenderVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, c := range loadDDL(t).Cases {
		t.Run(c.ID, func(t *testing.T) {
			for _, dialect := range []Dialect{DialectMySQL, DialectPostgres, DialectSQLite} {
				runTimed(t, c.ID, 5*time.Second, func() error {
					documents, err := parseDDLSet(c)
					if err != nil {
						return err
					}
					got, diagnostics := Render(documents, dialect)
					if len(diagnostics) > 0 {
						return fmt.Errorf("diagnostics %v", diagnostics)
					}
					want := c.Statements[string(dialect)]
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
			}
		})
	}
}
