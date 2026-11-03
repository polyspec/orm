package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeDbspecPlanInvalid runs the dbspec plan invalid recipe, tests/dbspec/plan-invalid.json, without a database (FCV-3).
// Requirements: PLN-45, PLN-46, PLN-47, PLN-48, PLN-49, PLN-50, PLN-51, PLN-52, PLN-53, PLN-54, PLN-55, PLN-56, PLN-57,
// PLN-58, PLN-59, PLN-60, PLN-61, PLN-62, PLN-63, PLN-64, PLN-65, PLN-66, PLN-67, PLN-68, PLN-69, PLN-70, PLN-71, PLN-72,
// PLN-84, PLN-85, PLN-86, PLN-87, PLN-88.
func TestRecipeDbspecPlanInvalid(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/plan-invalid.json", recipe.None)
}

// TestRecipeDbspecPlanChains runs the dbspec plan chains recipe, tests/dbspec/plan-chains.json, without a database (FCV-3).
// Requirements: PLN-45, PLN-46, PLN-47, PLN-48, PLN-49, PLN-50, PLN-51, PLN-52, PLN-53, PLN-54, PLN-55, PLN-56, PLN-57,
// PLN-58, PLN-59, PLN-60, PLN-61, PLN-62, PLN-63, PLN-64, PLN-65, PLN-66, PLN-67, PLN-68, PLN-69, PLN-70, PLN-71, PLN-72,
// PLN-84, PLN-85, PLN-86, PLN-87, PLN-88.
func TestRecipeDbspecPlanChains(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/plan-chains.json", recipe.None)
}

// TestRecipeDbspecPlanParse runs the dbspec plan parse recipe, tests/dbspec/plan-parse.json, without a database (FCV-3).
// Requirements: PLN-45, PLN-46, PLN-47, PLN-48, PLN-49, PLN-50, PLN-51, PLN-52, PLN-53, PLN-54, PLN-55, PLN-56, PLN-57,
// PLN-58, PLN-59, PLN-60, PLN-61, PLN-62, PLN-63, PLN-64, PLN-65, PLN-66, PLN-67, PLN-68, PLN-69, PLN-70, PLN-71, PLN-72,
// PLN-84, PLN-85, PLN-86, PLN-87, PLN-88, DBS-109.
func TestRecipeDbspecPlanParse(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/plan-parse.json", recipe.None)
}

// TestRecipeDbspecPlanComparisons runs the dbspec plan comparisons recipe, tests/dbspec/plan-comparisons.json, without a database (FCV-3).
// Requirements: PLN-45, PLN-46, PLN-47, PLN-48, PLN-49, PLN-50, PLN-51, PLN-52, PLN-53, PLN-54, PLN-55, PLN-56, PLN-57,
// PLN-58, PLN-59, PLN-60, PLN-61, PLN-62, PLN-63, PLN-64, PLN-65, PLN-66, PLN-67, PLN-68, PLN-69, PLN-70, PLN-71, PLN-72,
// PLN-84, PLN-85, PLN-86, PLN-87, PLN-88.
func TestRecipeDbspecPlanComparisons(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/plan-comparisons.json", recipe.None)
}
