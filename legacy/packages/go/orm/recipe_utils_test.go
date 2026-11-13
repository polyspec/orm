// Requirements: INT-51, INT-52, INT-53, INT-61, INT-73, INT-134, CFG-30, INT-50, INT-72, INT-79 (docs/spec/feature-coverage.md).
package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// utilsRecipe is the recipe of the connection utilities, relative to this package directory.
const utilsRecipe = "../../../contracts/fixtures/utils/utils.json"

// TestRecipeUtilsMysql runs the utils recipe on MySQL, each case on a case database (FCV-3).
// Requirements: INT-51, INT-52, INT-53, INT-61, INT-73, INT-134.
func TestRecipeUtilsMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, utilsRecipe, "mysql")
}

// TestRecipeUtilsMariadb runs the utils recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeUtilsMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, utilsRecipe, "mariadb")
}

// TestRecipeUtilsPostgres runs the utils recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: INT-51, INT-52, INT-53, INT-61, INT-73, INT-134.
func TestRecipeUtilsPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, utilsRecipe, "postgres")
}

// TestRecipeUtilsSqlite runs the utils recipe on SQLite, each case on a case database (FCV-3).
// Requirements: INT-51, INT-52, INT-53, INT-61, INT-73, INT-134.
func TestRecipeUtilsSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, utilsRecipe, "sqlite")
}

// TestRecipeUtilsMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeUtilsMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, utilsRecipe, "markdown")
}
