package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeInvalidNone runs the invalid cases of the dbspec format recipe, tests/dbspec/invalid.json, without a database (FCV-3).
// Requirements: ORES-19.
// Requirements: DBS-136, DBS-137, DBS-138, DBS-139, DBS-144, ORES-4, ORES-5, ORES-6, ORES-7, ORES-8, ORES-9, ORES-10, ORES-11, ORES-13.
func TestRecipeInvalidNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/invalid.json", recipe.None)
}
