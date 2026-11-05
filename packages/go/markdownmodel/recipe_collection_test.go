package markdownmodel_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeCollectionNone runs the collection recipe, tests/collection/collection.json, without a database (FCV-3, FCV-4): the
// identity of a collection key of every type.
// Requirements: INT-11, INT-63, PRT-35.
func TestRecipeCollectionNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/collection/collection.json", recipe.None)
}
