package orm_test

// Requirements: DSL-32, DSL-33, DIA-6, PRT-75, FCV-4, FCV-9, FCV-10.

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// fulltextSearchRecipe is the recipe of the full-text search, relative to this package directory.
var fulltextSearchRecipe = testcase.LegacyPath("contracts/fixtures/fulltext_search/fulltext_search.json")

// TestRecipeFulltextSearchMysql runs the fulltext_search recipe on MySQL, each case on a case database (FCV-22).
// Requirements: DSL-32, DSL-33, DIA-6, PRT-75.
func TestRecipeFulltextSearchMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, fulltextSearchRecipe, "mysql")
}

// TestRecipeFulltextSearchMariadb runs the fulltext_search recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-22).
func TestRecipeFulltextSearchMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, fulltextSearchRecipe, "mariadb")
}

// TestRecipeFulltextSearchPostgres runs the fulltext_search recipe on PostgreSQL, each case on a case database (FCV-22).
// Requirements: DSL-32, DSL-33, DIA-6, PRT-75.
func TestRecipeFulltextSearchPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, fulltextSearchRecipe, "postgres")
}

// TestRecipeFulltextSearchSqlite runs the fulltext_search recipe on SQLite, each case on a case database (FCV-22).
// Requirements: DSL-32, DSL-33, DIA-6, PRT-75.
func TestRecipeFulltextSearchSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, fulltextSearchRecipe, "sqlite")
}
