package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeDbspecShowCreateIntrospectNone runs The MySQL introspection of the checks of SHOW CREATE TABLE on the canned catalog of tests/dbspec/show-create.json, the recipe tests/dbspec/show-create-introspect.json (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DIA-84.
func TestRecipeDbspecShowCreateIntrospectNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/show-create-introspect.json", recipe.None)
}
