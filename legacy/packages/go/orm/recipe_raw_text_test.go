// Requirements: PRT-67 (docs/spec/feature-coverage.md FCV-3).
package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// rawTextRecipe is the recipe of a text that is not UTF-8, relative to this package directory.
const rawTextRecipe = "../../../contracts/fixtures/raw_text/raw_text.json"

// TestRecipeRawTextMysql runs the raw_text recipe on MySQL, each case on a case database (FCV-3).
func TestRecipeRawTextMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, rawTextRecipe, "mysql")
}

// TestRecipeRawTextMariadb runs the raw_text recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeRawTextMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, rawTextRecipe, "mariadb")
}

// TestRecipeRawTextPostgres runs the raw_text recipe on PostgreSQL, each case on a case database (FCV-3).
func TestRecipeRawTextPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, rawTextRecipe, "postgres")
}

// TestRecipeRawTextSqlite runs the raw_text recipe on SQLite, each case on a case database (FCV-3).
func TestRecipeRawTextSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, rawTextRecipe, "sqlite")
}

// TestRecipeRawTextMarkdown runs the raw_text recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeRawTextMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, rawTextRecipe, "markdown")
}
