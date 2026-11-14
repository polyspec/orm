package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeSetsNone runs the document set cases of the dbspec manifest (DBS-99) recipe, tests/dbspec/sets.json, without a database (FCV-3).
// Requirements: DBS-30, DBS-35, DBS-99, DBS-101, DBS-105, DBS-106, DBS-168.
// Requirements: ORES-13.
func TestRecipeSetsNone(t *testing.T) {
	testcase.Start(t)
	recipe.Run(t, testcase.LegacyPath("tests/dbspec/sets.json"), recipe.None)
}
