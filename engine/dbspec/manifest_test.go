package dbspec

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

// hashCase is one `hashes` case of tests/dbspec/cases.json: every listed
// document is parsed against the others, and the document set has the listed
// manifest and schema texts and hashes.
type hashCase struct {
	ID           string              `json:"id"`
	Documents    map[string][]string `json:"documents"`
	ManifestText []string            `json:"manifestText"`
	SchemaText   []string            `json:"schemaText"`
	ManifestHash string              `json:"manifestHash"`
	SchemaHash   string              `json:"schemaHash"`
}

// parseSet parses every document of the case against the others, in
// document name order.
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
				// The set is ordered by document name, not by the order given.
				slices.Reverse(documents)
				return expectManifest(c, documents)
			})
		})
	}
}

func TestManifestRejectsRepeatedDocumentName(t *testing.T) {
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

// setCase is one `sets` case of tests/dbspec/cases.json: the listed
// documents form the set, each parsed against the other listed documents and
// the parsing documents.
type setCase struct {
	ID        string              `json:"id"`
	Documents [][]string          `json:"documents"`
	Parsing   map[string][]string `json:"parsing"`
	Errors    []vectorError       `json:"errors"`
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
	vectors := loadVectors(t)
	if len(vectors.Sets) == 0 {
		t.Fatal("tests/dbspec/cases.json has no sets cases")
	}
	for _, c := range vectors.Sets {
		t.Run(c.ID, func(t *testing.T) {
			runTimed(t, "sets/"+c.ID, 5*time.Second, func() error {
				var documents []*Document
				for i, lines := range c.Documents {
					set := map[string]string{}
					for name, other := range c.Parsing {
						set[name] = joinLines(other, false)
					}
					for j, other := range c.Documents {
						if j != i {
							name := strings.TrimPrefix(other[0], "dbspec 1 ")
							set[name] = joinLines(other, false)
						}
					}
					document, diagnostics := Parse(joinLines(lines, false), set)
					if err := expectDocument(document, diagnostics); err != nil {
						return fmt.Errorf("document %d: %w", i+1, err)
					}
					documents = append(documents, document)
				}
				manifest, diagnostics := ManifestOf(documents)
				if err := expectSetErrors(c.Errors, diagnostics); err != nil {
					return fmt.Errorf("manifest: %w", err)
				}
				if (manifest == nil) != (len(c.Errors) > 0) {
					return fmt.Errorf("manifest present: %v with %d errors", manifest != nil, len(c.Errors))
				}
				for _, dialect := range []Dialect{DialectMySQL, DialectPostgres, DialectSQLite} {
					statements, diagnostics := Render(documents, dialect)
					if err := expectSetErrors(c.Errors, diagnostics); err != nil {
						return fmt.Errorf("render %s: %w", dialect, err)
					}
					if (len(statements) == 0) != (len(c.Errors) > 0) {
						return fmt.Errorf("render %s: %d statements with %d errors", dialect, len(statements), len(c.Errors))
					}
				}
				return nil
			})
		})
	}
}
