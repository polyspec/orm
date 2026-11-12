package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeDbspecLimitsNone runs The limit and stress recipe, tests/dbspec/limits.json, without a database (FCV-3, FCV-4).
// Requirements: DBS-123, DBS-144, DBS-151, DBS-170.
func TestRecipeDbspecLimitsNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/limits.json", recipe.None)
}
