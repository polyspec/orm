package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipePositionsNone runs the declaration position cases of the dbspec parse recipe, tests/dbspec/positions.json, without a database (FCV-3).
// Requirements: ORES-72.
func TestRecipePositionsNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/positions.json", recipe.None)
}
