package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeInvalidNone runs the invalid cases of the dbspec format recipe, tests/dbspec/invalid.json, without a database (FCV-3).
// Requirements: ORES-19.
func TestRecipeInvalidNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/invalid.json", recipe.None)
}
