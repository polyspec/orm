package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeDbspecApplyVerificationErrorsNone runs The apply verification errors of tests/dbspec/apply-verification-errors.json on a memory connection.
// Requirements: PLN-92, PLN-93, PLN-96.
func TestRecipeDbspecApplyVerificationErrorsNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/apply-verification-errors.json", recipe.None)
}
