package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipePlannerCompileNone runs the planner compile recipe, tests/planner/compile.json, without a database (FCV-3).
// Requirements: COD-4, DIA-33, PRT-69, PRT-6, PRT-13, PRT-14, PRT-16, PRT-17, PRT-20, PRT-21, PRT-22, PRT-23, PRT-25, PRT-31, PRT-32, PRT-33,
// DSL-16, DSL-24, DSL-34, DSL-74, DSL-78, DSL-99, DSL-138, DSL-147, DSL-148, DIA-1, DIA-2, DIA-3, DIA-4, DIA-5, DIA-7,
// DIA-8, DIA-9, DIA-12, DIA-13, DIA-18, DIA-22, DIA-23, DIA-24, DIA-27, DIA-31, DIA-35, COD-43, PRT-7, PRT-19, PRT-37,
// PRT-67, PRT-78, DSL-95.
func TestRecipePlannerCompileNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/planner/compile.json", recipe.None)
}
