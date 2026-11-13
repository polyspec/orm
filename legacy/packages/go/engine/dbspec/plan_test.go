package dbspec

import (
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/dbspec/plancases"
)

// loadPlanCases reads the cases of tests/dbspec/plan-cases.json, the recipe in plan-cases.json. Its cases are run by
// the recipe TestRecipeDbspecPlanCases (packages/go/orm), so this package reads them only for its own checks.
func loadPlanCases(t *testing.T) []plancases.Case {
	t.Helper()
	cases, err := plancases.Read(filepath.Join(legacyRoot(t), "tests", "dbspec", "plan-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	return cases
}

// decodePlanVectors reads the section of plan-cases.json that this package checks: its version. The cases are the recipe
// plan-cases.json, and the other fields are checked by the schema.
func decodePlanVectors(r vectorReader, object map[string]any) error {
	return r.version(object)
}
