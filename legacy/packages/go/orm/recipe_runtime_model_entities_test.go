package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeRuntimeModelEntitiesNone runs The entities of the runtime model, tests/dbspec/runtime-model.json, without a database (FCV-3, FCV-4).
// Requirements: DBS-65, DBS-85, DBS-111, DBS-112, DBS-100, DBS-103.
func TestRecipeRuntimeModelEntitiesNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/runtime-model.json", recipe.None)
}
