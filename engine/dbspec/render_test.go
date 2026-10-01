package dbspec

import (
	"fmt"
	"slices"
	"testing"
	"time"
)

// ddlFile은 tests/dbspec/ddl.json이다. 문서 집합과 Render가 dialect마다 쓰는 statement를
// 담는다(docs/dialects.md "Rendered statements").
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

// decodeDDLVectors는 ddl.json의 case와 field를 읽고, 없거나 type이 다른 값을 위치와
// 함께 거부한다.
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

// parseDDLSet은 case의 모든 문서를 나머지 문서에 대해 parse한다.
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
			})
		}
	}
}
