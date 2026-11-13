package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeFilesNone runs the document file cases of the dbspec reader recipe, tests/dbspec/files.json, without a database (FCV-3).
// Requirements: DBS-4, DBS-155, DBS-171.
func TestRecipeFilesNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/files.json", recipe.None)
}
