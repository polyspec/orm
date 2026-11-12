package orm_test

// Requirements: FCV-8, FCV-9, FCV-10, FCV-13, FCV-14.

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// modelWritesRecipe is the recipe of the generated-model writes, relative to this package directory.
const modelWritesRecipe = "../../../contracts/fixtures/model_writes/model_writes.json"

// TestRecipeModelWritesMysql runs the model_writes recipe on MySQL, each case on a case database (FCV-3).
// Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-109, DSL-110, PLN-26.
func TestRecipeModelWritesMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelWritesRecipe, "mysql")
}

// TestRecipeModelWritesMariadb runs the model_writes recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeModelWritesMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelWritesRecipe, "mariadb")
}

// TestRecipeModelWritesPostgres runs the model_writes recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-109, DSL-110, PLN-26.
func TestRecipeModelWritesPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelWritesRecipe, "postgres")
}

// TestRecipeModelWritesSqlite runs the model_writes recipe on SQLite, each case on a case database (FCV-3).
// Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-109, DSL-110, PLN-26.
func TestRecipeModelWritesSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelWritesRecipe, "sqlite")
}

// TestRecipeModelWritesMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeModelWritesMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, modelWritesRecipe, "markdown")
}
