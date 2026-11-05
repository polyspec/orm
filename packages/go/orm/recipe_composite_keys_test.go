package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// compositeKeysRecipe is the recipe of the composite key rows, relative to this package directory.
const compositeKeysRecipe = "../../../contracts/fixtures/composite_keys/composite_keys.json"

// TestRecipeCompositeKeysMysql runs the composite_keys recipe on mysql, each case on a case database (FCV-3).
// Requirements: DSL-82, INT-87, PRT-12, PRT-40.
func TestRecipeCompositeKeysMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, compositeKeysRecipe, "mysql")
}

// TestRecipeCompositeKeysPostgres runs the composite_keys recipe on postgres, each case on a case database (FCV-3).
// Requirements: DSL-82, INT-87, PRT-12, PRT-40.
func TestRecipeCompositeKeysPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, compositeKeysRecipe, "postgres")
}

// TestRecipeCompositeKeysSqlite runs the composite_keys recipe on sqlite, each case on a case database (FCV-3).
// Requirements: DSL-82, INT-87, PRT-12, PRT-40.
func TestRecipeCompositeKeysSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, compositeKeysRecipe, "sqlite")
}

// TestRecipeCompositeKeysMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeCompositeKeysMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, compositeKeysRecipe, "markdown")
}
