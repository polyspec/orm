package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipePositionsNone runs the declaration position cases of the dbspec parse recipe, tests/dbspec/positions.json, without a database (FCV-3).
// Requirements: ORES-72.
func TestRecipePositionsNone(t *testing.T) {
	testcase.Start(t)
	recipe.Run(t, testcase.LegacyPath("tests/dbspec/positions.json"), recipe.None)
}
