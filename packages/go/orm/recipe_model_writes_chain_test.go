package orm_test

// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// modelWritesChainRecipe is the recipe of the model write chains on the builder, relative to this package directory.
const modelWritesChainRecipe = "../../../contracts/fixtures/model_writes_chain/model_writes_chain.json"

// TestRecipeModelWritesChainMysql runs the model_writes_chain recipe on MySQL, each case on a case database (FCV-3).
// Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26, DSL-104, DSL-107, INT-35, PRT-41.
func TestRecipeModelWritesChainMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelWritesChainRecipe, "mysql")
}

// TestRecipeModelWritesChainPostgres runs the model_writes_chain recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26, DSL-104, DSL-107, INT-35, PRT-41.
func TestRecipeModelWritesChainPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelWritesChainRecipe, "postgres")
}

// TestRecipeModelWritesChainSqlite runs the model_writes_chain recipe on SQLite, each case on a case database (FCV-3).
// Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26, DSL-104, DSL-107, INT-35, PRT-41.
func TestRecipeModelWritesChainSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelWritesChainRecipe, "sqlite")
}
