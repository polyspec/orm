package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeDbspecIntrospectMessagesNone runs The SQLite unsupported column reason of tests/dbspec/introspect-messages.json on a memory connection (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DIA-191.
func TestRecipeDbspecIntrospectMessagesNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, testcase.LegacyPath("tests/dbspec/introspect-messages.json"), recipe.None)
}
