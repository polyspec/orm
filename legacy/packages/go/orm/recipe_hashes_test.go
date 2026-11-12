package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeHashesNone runs the manifest hash cases of the dbspec manifest (DBS-103) recipe, tests/dbspec/hashes.json, without a database (FCV-3).
// Requirements: DBS-65, ORES-16, DBS-86, DBS-94, DBS-99, DBS-100, DBS-102, DBS-103, DIA-97.
// Requirements: ORES-13.
func TestRecipeHashesNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/hashes.json", recipe.None)
}
