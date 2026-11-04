package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeDbspecRenderStatementsNone runs the rendered statements recipe, tests/dbspec/render-statements.json, without a database (FCV-3).
// Requirements: DBS-35, DBS-37, DBS-41, DBS-84, DBS-88, DBS-90, DBS-91, DBS-92, DBS-93, DBS-95, DBS-96, DIA-25, DIA-28, DIA-30.
// Requirements: DIA-113, DIA-114, DIA-115, DIA-116, DIA-117, DIA-118, DIA-119, DIA-120, DIA-121, DIA-122, DIA-123, DIA-124.
// Requirements: DIA-125, DIA-126, DIA-127, DIA-128, DIA-129, DIA-130, DIA-131, DIA-132.
func TestRecipeDbspecRenderStatementsNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/render-statements.json", recipe.None)
}
