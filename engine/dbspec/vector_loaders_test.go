package dbspec

import (
	"fmt"
	"testing"
	"time"

	"github.com/polyspec/orm/internal/testcase"
)

// vectorCaseOf는 object의 section key에서 index번째 case object다.
func vectorCaseOf(object map[string]any, key string, index int) map[string]any {
	return object[key].([]any)[index].(map[string]any)
}

// TestVectorLoadersRejectMalformedVectors는 engine test가 tests/dbspec vector를 읽을 때
// 없거나 type이 다른 section과 field를 "<file>: <location> <problem>" error로
// 거부하는지 확인한다.
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
			vectorCaseOf(o, "cases", 0)["steps"].(map[string]any)["mysql"] = "CREATE TABLE"
		}},
		{"plans.json", "cases[0].steps.mysql[0]", "has the unknown key statements", func(o map[string]any) {
			vectorCaseOf(o, "cases", 0)["steps"].(map[string]any)["mysql"].([]any)[0].(map[string]any)["statements"] = "CREATE TABLE"
		}},
		{"plans.json", "invalid[0].source", "is missing", func(o map[string]any) { delete(vectorCaseOf(o, "invalid", 0), "source") }},
		{"plans.json", "chains[0]", "has neither or both of order and errors", func(o map[string]any) { delete(vectorCaseOf(o, "chains", 0), "order") }},
		{"plans.json", "parse[0].errors[0][1]", "is not an integer", func(o map[string]any) {
			vectorCaseOf(o, "parse", 0)["errors"].([]any)[0].([]any)[1] = "1"
		}},
		{"plans.json", "comparisons[1].differences[0]", "does not have 3 strings", func(o map[string]any) {
			vectorCaseOf(o, "comparisons", 1)["differences"].([]any)[0] = []any{"create_table", "orders"}
		}},
		{"mermaid.json", "export[0].dropped", "is missing", func(o map[string]any) { delete(vectorCaseOf(o, "export", 0), "dropped") }},
		{"mermaid.json", "invalid[0].errors[0]", "does not have 3 items", func(o map[string]any) {
			vectorCaseOf(o, "invalid", 0)["errors"].([]any)[0] = []any{"mermaid", 1.0}
		}},
		{"mermaid.json", "round_trip[0].path", "is not a string", func(o map[string]any) { vectorCaseOf(o, "round_trip", 0)["path"] = 1.0 }},
		{"cases.json", "normalize[0].canonical", "is missing", func(o map[string]any) { delete(vectorCaseOf(o, "normalize", 0), "canonical") }},
		{"cases.json", "invalid[0].errors[0].rule", "is missing", func(o map[string]any) {
			delete(vectorCaseOf(o, "invalid", 0)["errors"].([]any)[0].(map[string]any), "rule")
		}},
		{"cases.json", "hashes[0].schemaHash", "is not a string", func(o map[string]any) { vectorCaseOf(o, "hashes", 0)["schemaHash"] = 1.0 }},
		{"cases.json", "sets", "is missing", func(o map[string]any) { delete(o, "sets") }},
		{"ddl.json", "cases[0].statements", "is missing", func(o map[string]any) { delete(vectorCaseOf(o, "cases", 0), "statements") }},
	}
	for _, m := range mutations {
		t.Run(m.file+"/"+m.location, func(t *testing.T) {
			r, object := readVectorFile(t, m.file)
			runTimed(t, "vectors/"+m.file+"/"+m.location, 5*time.Second, func() error {
				m.change(object)
				want := r.path + ": " + m.location + " " + m.problem
				if err := decoders[m.file](r, object); err == nil || err.Error() != want {
					return fmt.Errorf("want error %q, got %v", want, err)
				}
				return nil
			})
		})
	}
}
