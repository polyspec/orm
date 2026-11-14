package dbspec

import (
	"fmt"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestVectorLoadersRejectMalformedVectors checks that the engine test, when reading tests/dbspec vectors,
// rejects sections and fields that are missing or of the wrong type with a "<file>: <location> <problem>" error;
// the test checks that it does.
func TestVectorLoadersRejectMalformedVectors(t *testing.T) {
	testcase.Start(t)
	decoders := map[string]func(vectorReader, map[string]any) error{
		"plan-cases.json": decodePlanVectors,
	}
	mutations := []struct {
		file, location, problem string
		change                  func(o map[string]any)
	}{
		{"plan-cases.json", "version", "is missing", func(o map[string]any) { delete(o, "version") }},
	}
	for _, m := range mutations {
		t.Run(m.file+":"+m.location, func(t *testing.T) {
			r, object := readVectorFile(t, m.file)
			runTimed(t, m.file+":"+m.location, func() error {
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
