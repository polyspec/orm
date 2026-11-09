// Requirements: DBS-108, DBS-119, DBS-120, INT-55, INT-77, INT-91, SCH-7, SCH-11, INT-96, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md), INT-149.
package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// statementEventsRecipe is the recipe of the statement events, relative to this package directory.
const statementEventsRecipe = "../../../contracts/fixtures/statement_events/statement_events.json"

// TestRecipeStatementEventsMysql runs the statement_events recipe on MySQL, each case on a case database (FCV-3).
// Requirements: DBS-108, DBS-119, DBS-120, INT-55, INT-77, INT-91, SCH-7, SCH-11.
func TestRecipeStatementEventsMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, statementEventsRecipe, "mysql")
}

// TestRecipeStatementEventsMariadb runs the statement_events recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeStatementEventsMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, statementEventsRecipe, "mariadb")
}

// TestRecipeStatementEventsPostgres runs the statement_events recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: DBS-108, DBS-119, DBS-120, INT-55, INT-77, INT-91, SCH-7, SCH-11.
func TestRecipeStatementEventsPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, statementEventsRecipe, "postgres")
}

// TestRecipeStatementEventsSqlite runs the statement_events recipe on SQLite, each case on a case database (FCV-3).
// Requirements: DBS-108, DBS-119, DBS-120, INT-55, INT-77, INT-91, SCH-7, SCH-11.
func TestRecipeStatementEventsSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, statementEventsRecipe, "sqlite")
}

// TestRecipeStatementEventsMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeStatementEventsMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, statementEventsRecipe, "markdown")
}
