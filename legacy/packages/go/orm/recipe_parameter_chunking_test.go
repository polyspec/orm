// Recipe conversion of parameter chunking: FCV-4 (model.count and model.query, where as an IN list and limit as the
// public Limit), FCV-8 to FCV-14 (docs/spec/feature-coverage.md).
package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// parameterChunkingRecipe is the recipe of parameter chunking, relative to this package directory.
const parameterChunkingRecipe = "../../../contracts/fixtures/parameter_chunking/parameter_chunking.json"

// TestRecipeParameterChunkingMysql runs the parameter_chunking recipe on MySQL, each case on a case database (FCV-3).
// Requirements: PLN-44, PRT-35, PRT-76.
func TestRecipeParameterChunkingMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, parameterChunkingRecipe, "mysql")
}

// TestRecipeParameterChunkingMariadb runs the parameter_chunking recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeParameterChunkingMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, parameterChunkingRecipe, "mariadb")
}

// TestRecipeParameterChunkingPostgres runs the parameter_chunking recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: PLN-44, PRT-35, PRT-76.
func TestRecipeParameterChunkingPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, parameterChunkingRecipe, "postgres")
}

// TestRecipeParameterChunkingSqlite runs the parameter_chunking recipe on SQLite, each case on a case database (FCV-3).
// Requirements: PLN-44, PRT-35, PRT-76.
func TestRecipeParameterChunkingSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, parameterChunkingRecipe, "sqlite")
}

// TestRecipeParameterChunkingMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeParameterChunkingMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, parameterChunkingRecipe, "markdown")
}
