package dbspec

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/internal/testcase"
)

// hashCase는 tests/dbspec/cases.json의 `hashes` case 하나다. 나열한 각 문서를 나머지 문서에
// 대해 parse하고, 문서 집합은 나열한 manifest text, schema text와 hash를 가진다.
type hashCase struct {
	ID           string
	Documents    map[string][]string
	ManifestText []string
	SchemaText   []string
	ManifestHash string
	SchemaHash   string
}

// parseSet은 case의 모든 문서를 나머지 문서에 대해 문서 이름 순으로 parse한다.
func (c hashCase) parseSet() ([]*Document, error) {
	names := make([]string, 0, len(c.Documents))
	for name := range c.Documents {
		names = append(names, name)
	}
	slices.Sort(names)
	documents := make([]*Document, 0, len(names))
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

func expectManifest(c hashCase, documents []*Document) error {
	manifest, diagnostics := ManifestOf(documents)
	if len(diagnostics) > 0 {
		return fmt.Errorf("diagnostics %v", diagnostics)
	}
	if want := joinLines(c.ManifestText, false); manifest.ManifestText != want {
		return fmt.Errorf("manifest text = %q, want %q", manifest.ManifestText, want)
	}
	if want := joinLines(c.SchemaText, false); manifest.SchemaText != want {
		return fmt.Errorf("schema text = %q, want %q", manifest.SchemaText, want)
	}
	if manifest.ManifestHash != c.ManifestHash || manifest.SchemaHash != c.SchemaHash {
		return fmt.Errorf("hashes = %s %s, want %s %s", manifest.ManifestHash, manifest.SchemaHash, c.ManifestHash, c.SchemaHash)
	}
	return nil
}

func TestManifestVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	vectors := loadVectors(t)
	if len(vectors.Hashes) == 0 {
		t.Fatal("tests/dbspec/cases.json has no hashes cases")
	}
	for _, c := range vectors.Hashes {
		t.Run(c.ID, func(t *testing.T) {
			runTimed(t, "hashes/"+c.ID, 5*time.Second, func() error {
				documents, err := c.parseSet()
				if err != nil {
					return err
				}
				if err := expectManifest(c, documents); err != nil {
					return err
				}
				// 집합은 주어진 순서가 아니라 문서 이름 순으로 정렬된다.
				slices.Reverse(documents)
				return expectManifest(c, documents)
			})
		})
	}
}

func TestManifestRejectsRepeatedDocumentName(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	runTimed(t, "manifest/repeated-name", 5*time.Second, func() error {
		text := strings.Join([]string{"dbspec 1 shop", "", "table users {", "  id i64 identity", "  primary key (id)", "}", ""}, "\n")
		first, diagnostics := Parse(text, nil)
		if err := expectDocument(first, diagnostics); err != nil {
			return err
		}
		second, _ := Parse(text, nil)
		manifest, diagnostics := ManifestOf([]*Document{first, second})
		if manifest != nil {
			return fmt.Errorf("a set that repeats a document name has a manifest")
		}
		want := []Diagnostic{{Rule: RuleNameDuplicate, Line: 1, Column: 10}}
		if len(diagnostics) != 1 || diagnostics[0].Rule != want[0].Rule || diagnostics[0].Line != 1 || diagnostics[0].Column != 10 {
			return fmt.Errorf("diagnostics = %v, want %v", diagnostics, want)
		}
		return nil
	})
}

// setCase는 tests/dbspec/cases.json의 `sets` case 하나다. 나열한 문서가 집합을 이루며, 각
// 문서는 나열한 다른 문서와 parsing 문서에 대해 parse한다.
type setCase struct {
	ID        string
	Documents [][]string
	// External은 set이 소유하지 않고 use로 쓰는 외부 문서다.
	External [][]string
	Parsing  map[string][]string
	Errors   []vectorError
	Manifest *setManifest
}

// setManifest는 유효한 set의 manifest와 render가 만드는 table이다. 빈 text는 빈 배열이다.
type setManifest struct {
	ManifestText, ExternalText, SchemaText []string
	ManifestHash, SchemaHash               string
	Created                                []string
}

// textOf는 줄을 LF로 잇는다. 줄이 없으면 빈 text다.
func textOf(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return joinLines(lines, false)
}

// createdTables는 statement 가운데 CREATE TABLE이 만드는 table 이름이다.
func createdTables(statements []string) []string {
	var out []string
	for _, s := range statements {
		if rest, ok := strings.CutPrefix(s, "CREATE TABLE "); ok {
			name, _, _ := strings.Cut(rest, " ")
			out = append(out, strings.Trim(name, "`\""))
		}
	}
	return out
}

func expectSetErrors(want []vectorError, got []Diagnostic) error {
	if len(got) != len(want) {
		return fmt.Errorf("diagnostics %v, want %v", got, want)
	}
	for i := range want {
		if got[i].Rule != want[i].Rule || got[i].Line != want[i].Line || got[i].Column != want[i].Column {
			return fmt.Errorf("diagnostics %v, want %v", got, want)
		}
	}
	return nil
}

func TestDocumentSets(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	vectors := loadVectors(t)
	if len(vectors.Sets) == 0 {
		t.Fatal("tests/dbspec/cases.json has no sets cases")
	}
	for _, c := range vectors.Sets {
		t.Run(c.ID, func(t *testing.T) {
			runTimed(t, "sets/"+c.ID, 5*time.Second, func() error {
				// 각 문서는 다른 소유 문서, 외부 문서, parsing 문서를 집합으로 parse한다.
				all := append(slices.Clone(c.Documents), c.External...)
				var documents []*Document
				for i, lines := range all {
					set := map[string]string{}
					for name, other := range c.Parsing {
						set[name] = joinLines(other, false)
					}
					for j, other := range all {
						if j != i {
							name := strings.TrimPrefix(other[0], "dbspec 1 ")
							set[name] = joinLines(other, false)
						}
					}
					document, diagnostics := Parse(joinLines(lines, false), set)
					if err := expectDocument(document, diagnostics); err != nil {
						return fmt.Errorf("document %d: %w", i+1, err)
					}
					document.External = i >= len(c.Documents)
					documents = append(documents, document)
				}
				manifest, diagnostics := ManifestOf(documents)
				if err := expectSetErrors(c.Errors, diagnostics); err != nil {
					return fmt.Errorf("manifest: %w", err)
				}
				if (manifest == nil) != (len(c.Errors) > 0) {
					return fmt.Errorf("manifest present: %v with %d errors", manifest != nil, len(c.Errors))
				}
				if want := c.Manifest; want != nil {
					for _, field := range []struct{ name, got, want string }{
						{"manifestText", manifest.ManifestText, textOf(want.ManifestText)},
						{"externalText", manifest.ExternalText, textOf(want.ExternalText)},
						{"schemaText", manifest.SchemaText, textOf(want.SchemaText)},
						{"manifestHash", manifest.ManifestHash, want.ManifestHash},
						{"schemaHash", manifest.SchemaHash, want.SchemaHash},
					} {
						if field.got != field.want {
							return fmt.Errorf("%s:\n%s\nwant\n%s", field.name, field.got, field.want)
						}
					}
				}
				for _, dialect := range []Dialect{DialectMySQL, DialectPostgres, DialectSQLite} {
					statements, diagnostics := Render(documents, dialect)
					if err := expectSetErrors(c.Errors, diagnostics); err != nil {
						return fmt.Errorf("render %s: %w", dialect, err)
					}
					if (len(statements) == 0) != (len(c.Errors) > 0) {
						return fmt.Errorf("render %s: %d statements with %d errors", dialect, len(statements), len(c.Errors))
					}
					if c.Manifest != nil {
						if got := createdTables(statements); !slices.Equal(got, c.Manifest.Created) {
							return fmt.Errorf("render %s creates %v, want %v", dialect, got, c.Manifest.Created)
						}
					}
				}
				return nil
			})
		})
	}
}
