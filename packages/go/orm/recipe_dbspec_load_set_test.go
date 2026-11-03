package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeDbspecLoadSetNone runs The load of a document set, tests/dbspec/load-set.json, without a database (FCV-3, FCV-4).
// Requirements: SCH-12, DBS-156.
func TestRecipeDbspecLoadSetNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/dbspec/load-set.json", recipe.None)
}
