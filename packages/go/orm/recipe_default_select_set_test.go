package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeDefaultSelectSetNone runs The default select set, tests/planner/default-select-set.json, without a database (FCV-3, FCV-4).
// Requirements: PRT-9, DBS-68.
func TestRecipeDefaultSelectSetNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/planner/default-select-set.json", recipe.None)
}
