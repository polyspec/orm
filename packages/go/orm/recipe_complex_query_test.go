package orm_test

// Requirements: CPX-1, CPX-2, FCV-2, FCV-3, FCV-4.

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// complexQueryRecipe is the recipe of the product search, relative to this package directory.
const complexQueryRecipe = "../../../contracts/fixtures/complex_query/complex_query.json"

// TestRecipeComplexQueryMysql runs the complex_query recipe on MySQL, each case on a case database (FCV-3).
func TestRecipeComplexQueryMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, complexQueryRecipe, "mysql")
}

// TestRecipeComplexQueryPostgres runs the complex_query recipe on PostgreSQL, each case on a case database (FCV-3).
func TestRecipeComplexQueryPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, complexQueryRecipe, "postgres")
}

// TestRecipeComplexQuerySqlite runs the complex_query recipe on SQLite, each case on a case database (FCV-3).
func TestRecipeComplexQuerySqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, complexQueryRecipe, "sqlite")
}
