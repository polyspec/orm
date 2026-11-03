// Requirements: CFG-4, CFG-5, CFG-5a, PRT-77 (docs/spec/feature-coverage.md FCV-3).
package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// connectionPoolRecipe is the recipe of the pool options, relative to this package directory.
const connectionPoolRecipe = "../../../contracts/fixtures/connection_pool/connection_pool.json"

// TestRecipeConnectionPoolMysql runs the connection_pool recipe on mysql, each case on a case database (FCV-3).
// Requirements: CFG-4, CFG-5, PRT-77.
func TestRecipeConnectionPoolMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, connectionPoolRecipe, "mysql")
}

// TestRecipeConnectionPoolPostgres runs the connection_pool recipe on postgres, each case on a case database (FCV-3).
// Requirements: CFG-4, CFG-5, PRT-77.
func TestRecipeConnectionPoolPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, connectionPoolRecipe, "postgres")
}

// TestRecipeConnectionPoolSqlite runs the connection_pool recipe on sqlite, each case on a case database (FCV-3).
// Requirements: CFG-4, CFG-5, PRT-77.
func TestRecipeConnectionPoolSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, connectionPoolRecipe, "sqlite")
}
