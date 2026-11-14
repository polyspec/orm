package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeDbspecDialectRefusalNone runs The refusal of an unknown dialect, tests/dbspec/dialect-refusal.json, without a database (FCV-3, FCV-4).
// Requirements: DBS-174.
func TestRecipeDbspecDialectRefusalNone(t *testing.T) {
	testcase.Start(t)
	recipe.Run(t, testcase.LegacyPath("tests/dbspec/dialect-refusal.json"), recipe.None)
}
