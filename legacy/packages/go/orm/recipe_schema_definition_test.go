package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeSchemaDefinitionNone runs the schema definition recipe, tests/dbspec/schema-definition.json, without a database (FCV-3).
// Requirements: DBS-1, DBS-99, DBS-103, DBS-123, DBS-134, DBS-135, DBS-141, DBS-142, ORES-14.
func TestRecipeSchemaDefinitionNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, testcase.LegacyPath("tests/dbspec/schema-definition.json"), recipe.None)
}
