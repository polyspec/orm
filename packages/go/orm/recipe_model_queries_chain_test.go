package orm_test

// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// modelQueriesChainRecipe is the recipe of the model query chains on the builder, relative to this package directory.
const modelQueriesChainRecipe = "../../../contracts/fixtures/model_queries_chain/model_queries_chain.json"

// TestRecipeModelQueriesChainMysql runs the model_queries_chain recipe on MySQL, each case on a case database (FCV-3).
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-90, DSL-99, INT-16, INT-29, INT-30, INT-31, INT-32, INT-33, INT-36, INT-87, PLN-11, PLN-25, PRT-35.
func TestRecipeModelQueriesChainMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelQueriesChainRecipe, "mysql")
}

// TestRecipeModelQueriesChainPostgres runs the model_queries_chain recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-90, DSL-99, INT-16, INT-29, INT-30, INT-31, INT-32, INT-33, INT-36, INT-87, PLN-11, PLN-25, PRT-35.
func TestRecipeModelQueriesChainPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelQueriesChainRecipe, "postgres")
}

// TestRecipeModelQueriesChainSqlite runs the model_queries_chain recipe on SQLite, each case on a case database (FCV-3).
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-90, DSL-99, INT-16, INT-29, INT-30, INT-31, INT-32, INT-33, INT-36, INT-87, PLN-11, PLN-25, PRT-35.
func TestRecipeModelQueriesChainSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelQueriesChainRecipe, "sqlite")
}

// TestRecipeModelQueriesChainMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeModelQueriesChainMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelQueriesChainRecipe, "markdown")
}
