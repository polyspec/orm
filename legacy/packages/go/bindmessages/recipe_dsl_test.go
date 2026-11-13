package bindmessages_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeDslNone runs The chain value recipe, contracts/fixtures/dsl/dsl.json, without a database (FCV-3, FCV-4).
// Requirements: DSL-49, DSL-50, PLN-4.
func TestRecipeDslNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, testcase.LegacyPath("contracts/fixtures/dsl/dsl.json"), recipe.None, recipe.WithMarkdownSend(markdownSend), recipe.WithModelAssign(modelAssign))
}
