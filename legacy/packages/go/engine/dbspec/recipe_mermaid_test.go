package dbspec_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeMermaidNone runs the Mermaid recipe, tests/dbspec/mermaid.json, without a database (FCV-3).
// Requirements: MER-1, MER-2, MER-3, MER-4, MER-5, MER-6, MER-7, MER-8, MER-9, MER-10, MER-11, MER-12, MER-13.
func TestRecipeMermaidNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../../tests/dbspec/mermaid.json", recipe.None)
}
