package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeNormalizeNone runs the normalize cases of the dbspec format recipe, tests/dbspec/normalize.json, without a database (FCV-3).
// Requirements: ORES-15, ORES-17, ORES-19.
// Requirements: ORES-13.
func TestRecipeNormalizeNone(t *testing.T) {
	testcase.Start(t)
	recipe.Run(t, testcase.LegacyPath("tests/dbspec/normalize.json"), recipe.None)
}
