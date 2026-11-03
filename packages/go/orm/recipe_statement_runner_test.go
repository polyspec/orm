// Requirements: INT-150, INT-77, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// statementRunnerRecipe is the recipe of the statement runner, relative to this package directory.
const statementRunnerRecipe = "../../../contracts/fixtures/statement_runner/statement_runner.json"

// TestRecipeStatementRunnerMysql runs the statement_runner recipe on MySQL, each case on a case database (FCV-3).
// Requirements: INT-150, INT-77.
func TestRecipeStatementRunnerMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, statementRunnerRecipe, "mysql")
}

// TestRecipeStatementRunnerPostgres runs the statement_runner recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: INT-150, INT-77.
func TestRecipeStatementRunnerPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, statementRunnerRecipe, "postgres")
}

// TestRecipeStatementRunnerSqlite runs the statement_runner recipe on SQLite, each case on a case database (FCV-3).
// Requirements: INT-150, INT-77.
func TestRecipeStatementRunnerSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, statementRunnerRecipe, "sqlite")
}
