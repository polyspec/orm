package dbspec

import (
	"fmt"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

// vectorCaseOf is the index-th case object, found by the section key of the object.
func vectorCaseOf(object map[string]any, key string, index int) map[string]any {
	return asFixture[map[string]any](asFixture[[]any](object[key])[index])
}

// TestVectorLoadersRejectMalformedVectors checks that the engine test, when reading tests/dbspec vectors,
// rejects sections and fields that are missing or of the wrong type with a "<file>: <location> <problem>" error;
// the test checks that it does.
func TestVectorLoadersRejectMalformedVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	decoders := map[string]func(vectorReader, map[string]any) error{
		"plans.json":   func(r vectorReader, o map[string]any) error { _, err := decodePlanVectors(r, o); return err },
		"mermaid.json": func(r vectorReader, o map[string]any) error { _, err := decodeMermaidVectors(r, o); return err },
		"cases.json":   func(r vectorReader, o map[string]any) error { _, err := decodeCaseVectors(r, o); return err },
		"ddl.json":     func(r vectorReader, o map[string]any) error { _, err := decodeDDLVectors(r, o); return err },
	}
	mutations := []struct {
		file, location, problem string
		change                  func(o map[string]any)
	}{
		{"plans.json", "version", "is missing", func(o map[string]any) { delete(o, "version") }},
		{"plans.json", "cases[0].changes", "is missing", func(o map[string]any) { delete(vectorCaseOf(o, "cases", 0), "changes") }},
		{"plans.json", "cases[0].steps.mysql", "is not an array", func(o map[string]any) {
			asFixture[map[string]any](vectorCaseOf(o, "cases", 0)["steps"])["mysql"] = "CREATE TABLE"
		}},
		{"plans.json", "cases[0].steps.mysql[0]", "has the unknown key statements", func(o map[string]any) {
			asFixture[map[string]any](asFixture[[]any](asFixture[map[string]any](vectorCaseOf(o, "cases", 0)["steps"])["mysql"])[0])["statements"] = "CREATE TABLE"
		}},
		{"plans.json", "invalid[0].source", "is missing", func(o map[string]any) { delete(vectorCaseOf(o, "invalid", 0), "source") }},
		{"plans.json", "chains[0]", "has neither or both of order and errors", func(o map[string]any) { delete(vectorCaseOf(o, "chains", 0), "order") }},
		{"plans.json", "parse[0].errors[0][1]", "is not an integer", func(o map[string]any) {
			asFixture[[]any](asFixture[[]any](vectorCaseOf(o, "parse", 0)["errors"])[0])[1] = "1"
		}},
		{"plans.json", "comparisons[1].differences[0]", "does not have 3 strings", func(o map[string]any) {
			asFixture[[]any](vectorCaseOf(o, "comparisons", 1)["differences"])[0] = []any{"create_table", "orders"}
		}},
		{"mermaid.json", "export[0].dropped", "is missing", func(o map[string]any) { delete(vectorCaseOf(o, "export", 0), "dropped") }},
		{"mermaid.json", "invalid[0].errors[0]", "does not have 3 items", func(o map[string]any) {
			asFixture[[]any](vectorCaseOf(o, "invalid", 0)["errors"])[0] = []any{"mermaid", 1.0}
		}},
		{"mermaid.json", "round_trip[0].path", "is not a string", func(o map[string]any) { vectorCaseOf(o, "round_trip", 0)["path"] = 1.0 }},
		{"cases.json", "normalize[0].canonical", "is missing", func(o map[string]any) { delete(vectorCaseOf(o, "normalize", 0), "canonical") }},
		{"cases.json", "invalid[0].errors[0].rule", "is missing", func(o map[string]any) {
			delete(asFixture[map[string]any](asFixture[[]any](vectorCaseOf(o, "invalid", 0)["errors"])[0]), "rule")
		}},
		{"cases.json", "hashes[0].schemaHash", "is not a string", func(o map[string]any) { vectorCaseOf(o, "hashes", 0)["schemaHash"] = 1.0 }},
		{"cases.json", "sets", "is missing", func(o map[string]any) { delete(o, "sets") }},
		{"cases.json", "note", "is missing", func(o map[string]any) { delete(o, "note") }},
		{"cases.json", "extra", "is not a known field", func(o map[string]any) { o["extra"] = []any{} }},
		{"cases.json", "canonical[0].extra", "is not a known field", func(o map[string]any) { vectorCaseOf(o, "canonical", 0)["extra"] = true }},
		{"cases.json", "normalize[0].extra", "is not a known field", func(o map[string]any) { vectorCaseOf(o, "normalize", 0)["extra"] = true }},
		{"cases.json", "invalid[0].errors[0].extra", "is not a known field", func(o map[string]any) {
			asFixture[map[string]any](asFixture[[]any](vectorCaseOf(o, "invalid", 0)["errors"])[0])["extra"] = 1.0
		}},
		{"cases.json", "hashes[0].extra", "is not a known field", func(o map[string]any) { vectorCaseOf(o, "hashes", 0)["extra"] = true }},
		{"cases.json", "sets[0].extra", "is not a known field", func(o map[string]any) { vectorCaseOf(o, "sets", 0)["extra"] = true }},
		{"cases.json", "sets[3].manifest.extra", "is not a known field", func(o map[string]any) {
			asFixture[map[string]any](vectorCaseOf(o, "sets", 3)["manifest"])["extra"] = []any{}
		}},
		{"cases.json", "files[0].extra", "is not a known field", func(o map[string]any) { vectorCaseOf(o, "files", 0)["extra"] = true }},
		{"cases.json", "positions[0].extra", "is not a known field", func(o map[string]any) { vectorCaseOf(o, "positions", 0)["extra"] = true }},
		{"cases.json", "positions[0].positions[0].extra", "is not a known field", func(o map[string]any) {
			asFixture[map[string]any](asFixture[[]any](vectorCaseOf(o, "positions", 0)["positions"])[0])["extra"] = 1.0
		}},
		{"ddl.json", "cases[0].statements", "is missing", func(o map[string]any) { delete(vectorCaseOf(o, "cases", 0), "statements") }},
	}
	for _, m := range mutations {
		t.Run(m.file+":"+m.location, func(t *testing.T) {
			r, object := readVectorFile(t, m.file)
			runTimed(t, m.file+":"+m.location, 5*time.Second, func() error {
				m.change(object)
				want := r.path + ": " + m.location + " " + m.problem
				err := decoders[m.file](r, object)
				if err == nil {
					return fmt.Errorf("want error %q, got none", want)
				}
				if err.Error() != want {
					return fmt.Errorf("want error %q, got %w", want, err)
				}
				return nil
			})
		})
	}
}
