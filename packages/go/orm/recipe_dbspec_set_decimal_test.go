// Requirements: DBS-108, SCH-7, FCV-3, FCV-4 (docs/spec/feature-coverage.md).
package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// dbspecSetDecimalRecipe is the recipe of the decimal document set, relative to this package directory.
const dbspecSetDecimalRecipe = "../../../tests/dbspec/set-decimal.json"

// TestRecipeDbspecSetDecimalMysql installs the decimal document set and round-trips its amounts on mysql.
// Requirements: DBS-108, SCH-7.
func TestRecipeDbspecSetDecimalMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecSetDecimalRecipe, "mysql")
}

// TestRecipeDbspecSetDecimalPostgres installs the decimal document set and round-trips its amounts on postgres.
// Requirements: DBS-108, SCH-7.
func TestRecipeDbspecSetDecimalPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecSetDecimalRecipe, "postgres")
}

// TestRecipeDbspecSetDecimalSqlite installs the decimal document set and round-trips its amounts on sqlite.
// Requirements: DBS-108, SCH-7.
func TestRecipeDbspecSetDecimalSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecSetDecimalRecipe, "sqlite")
}
