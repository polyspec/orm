package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeSetParseNone runs the document set parse cases recipe, tests/dbspec/set-parse.json, without a database (FCV-3).
// Requirements: DBS-2, DBS-28, DBS-29, DBS-30, DBS-31, DBS-156, DBS-168, DBS-171.
func TestRecipeSetParseNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/set-parse.json", recipe.None)
}
