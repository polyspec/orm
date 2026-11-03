package orm_test

// Requirements: FCV-3, FCV-4, FCV-9, FCV-13, CFG-10, CFG-19.

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// modelSocketRecipe is the recipe of the MySQL socket case, relative to this package directory.
const modelSocketRecipe = "../../../contracts/fixtures/model_socket/model_socket.json"

// TestRecipeModelSocketMysql runs the model_socket recipe on MySQL, each case on a case database (FCV-3).
// Requirements: CFG-10, CFG-19.
func TestRecipeModelSocketMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelSocketRecipe, "mysql")
}
