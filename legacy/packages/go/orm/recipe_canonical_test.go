package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeCanonicalNone runs the canonical cases of the dbspec format (ORES-19) recipe, tests/dbspec/canonical.json, without a database (FCV-3).
// Requirements: ORES-19.
// Requirements: DBS-133, ORES-1, ORES-3, ORES-13.
func TestRecipeCanonicalNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/canonical.json", recipe.None)
}
