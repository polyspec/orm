package orm_test

// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// modelQueriesRecipe is the recipe of the generated-model queries, relative to this package directory.
const modelQueriesRecipe = "../../../contracts/fixtures/model_queries/model_queries.json"

// TestRecipeModelQueriesMysql runs the model_queries recipe on MySQL, each case on a case database (FCV-3).
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30,
// INT-31, INT-32, INT-33, PLN-11, PLN-25, PRT-35.
func TestRecipeModelQueriesMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelQueriesRecipe, "mysql")
}

// TestRecipeModelQueriesMariadb runs the model_queries recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeModelQueriesMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelQueriesRecipe, "mariadb")
}

// TestRecipeModelQueriesPostgres runs the model_queries recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30,
// INT-31, INT-32, INT-33, PLN-11, PLN-25, PRT-35.
func TestRecipeModelQueriesPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelQueriesRecipe, "postgres")
}

// TestRecipeModelQueriesSqlite runs the model_queries recipe on SQLite, each case on a case database (FCV-3).
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30,
// INT-31, INT-32, INT-33, PLN-11, PLN-25, PRT-35.
func TestRecipeModelQueriesSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelQueriesRecipe, "sqlite")
}

// TestRecipeModelQueriesMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeModelQueriesMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelQueriesRecipe, "markdown")
}
