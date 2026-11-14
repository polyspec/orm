package ir_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeIRValidateNone runs the request validation recipe, tests/ir/validate.json, without a database (FCV-3).
// Requirements: PRT-1, INT-24, PRT-4, PRT-6, PRT-8, PRT-10, PRT-12, PRT-14, PRT-16, PRT-17, PRT-18, PRT-20, PRT-21, PRT-22, PRT-24, PRT-78,
// DBS-59, DBS-113, DSL-113, DSL-128.
func TestRecipeIRValidateNone(t *testing.T) {
	testcase.Start(t)
	recipe.Run(t, testcase.LegacyPath("tests/ir/validate.json"), recipe.None)
}
