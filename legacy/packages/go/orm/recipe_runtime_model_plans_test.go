package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeRuntimeModelPlansNone runs The plans of the runtime model, tests/planner/runtime-model.json, without a database (FCV-3, FCV-4).
// Requirements: DBS-112, PRT-32, PRT-81, PRT-82, DIA-24, PRT-33, DBS-67.
func TestRecipeRuntimeModelPlansNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/planner/runtime-model.json", recipe.None)
}
