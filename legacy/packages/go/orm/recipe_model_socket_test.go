package orm_test

// Requirements: FCV-3, FCV-4, FCV-9, FCV-13, CFG-10, CFG-19.

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// modelSocketRecipe is the recipe of the MySQL socket case, relative to this package directory.
var modelSocketRecipe = testcase.LegacyPath("contracts/fixtures/model_socket/model_socket.json")

// TestRecipeModelSocketMysql runs the model_socket recipe on MySQL, each case on a case database (FCV-3).
// Requirements: CFG-10, CFG-19.
func TestRecipeModelSocketMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelSocketRecipe, "mysql")
}

// TestRecipeModelSocketMariadb runs the model_socket recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeModelSocketMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelSocketRecipe, "mariadb")
}
