// Requirements: PLN-89, PLN-91, PLN-92, PLN-104, PLN-105 (docs/spec/feature-coverage.md).
package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// dbspecApplyRecipe is the recipe of the public apply API, relative to this package directory.
const dbspecApplyRecipe = "../../../contracts/fixtures/dbspec_apply/dbspec_apply.json"

// TestRecipeDbspecApplyMysql runs the dbspec_apply recipe on MySQL, each case on a case database (FCV-3).
// Requirements: PLN-89, PLN-91, PLN-92, PLN-104, PLN-105.
func TestRecipeDbspecApplyMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecApplyRecipe, "mysql")
}

// TestRecipeDbspecApplyPostgres runs the dbspec_apply recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: PLN-89, PLN-91, PLN-92, PLN-104, PLN-105.
func TestRecipeDbspecApplyPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecApplyRecipe, "postgres")
}

// TestRecipeDbspecApplySqlite runs the dbspec_apply recipe on SQLite, each case on a case database (FCV-3).
// Requirements: PLN-89, PLN-91, PLN-92, PLN-104, PLN-105.
func TestRecipeDbspecApplySqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecApplyRecipe, "sqlite")
}
