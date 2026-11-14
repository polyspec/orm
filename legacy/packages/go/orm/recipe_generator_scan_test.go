package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeGeneratorScanNone runs the generator scan recipe, contracts/fixtures/generator_scan/generator_scan.json, without a database (FCV-3).
// Requirements: DSL-44, DSL-151, DSL-152.
func TestRecipeGeneratorScanNone(t *testing.T) {
	testcase.Start(t)
	recipe.Run(t, testcase.LegacyPath("contracts/fixtures/generator_scan/generator_scan.json"), recipe.None)
}
