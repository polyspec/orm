package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeGeneratorNone runs the generator recipe, contracts/fixtures/generator/generator.json, without a database (FCV-3).
// Requirements: DSL-37, DSL-38, DSL-116, DSL-127, DSL-129, DSL-130, DSL-154, DBS-103, DBS-104, DBS-110, DBS-173, INT-66, PLN-1, PLN-22.
func TestRecipeGeneratorNone(t *testing.T) {
	testcase.Start(t, testcase.Process)
	recipe.Run(t, "../../../contracts/fixtures/generator/generator.json", recipe.None)
}
