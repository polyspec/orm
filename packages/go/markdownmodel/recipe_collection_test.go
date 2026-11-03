package markdownmodel_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeCollectionNone runs the collection recipe, tests/collection/collection.json, without a database (FCV-3, FCV-4): each
// ir.answer step runs the chain of its case on a listener that answers with the case's answer.
// Requirements: INT-68, INT-69, INT-70, INT-71, INT-90, PRT-69.
func TestRecipeCollectionNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/collection/collection.json", recipe.None, recipe.WithIRAnswer(chainAnswer(conformanceCases())))
}
