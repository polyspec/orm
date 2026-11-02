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
		"plan-cases.json": decodePlanVectors,
		"mermaid.json":    func(r vectorReader, o map[string]any) error { _, err := decodeMermaidVectors(r, o); return err },
		"ddl.json":        func(r vectorReader, o map[string]any) error { _, err := decodeDDLVectors(r, o); return err },
	}
	mutations := []struct {
		file, location, problem string
		change                  func(o map[string]any)
	}{
		{"plan-cases.json", "version", "is missing", func(o map[string]any) { delete(o, "version") }},
		{"mermaid.json", "export[0].dropped", "is missing", func(o map[string]any) { delete(vectorCaseOf(o, "export", 0), "dropped") }},
		{"mermaid.json", "invalid[0].errors[0]", "does not have 3 items", func(o map[string]any) {
			asFixture[[]any](vectorCaseOf(o, "invalid", 0)["errors"])[0] = []any{"mermaid", 1.0}
		}},
		{"mermaid.json", "round_trip[0].path", "is not a string", func(o map[string]any) { vectorCaseOf(o, "round_trip", 0)["path"] = 1.0 }},
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
