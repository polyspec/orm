package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

const immutableWriteRecipe = "../../../contracts/fixtures/immutable_write/immutable_write.json"

// TestRecipeImmutableWriteMysql runs the immutable_write recipe on Mysql, each case on a case database (FCV-3).
// Requirements: DBS-84.
func TestRecipeImmutableWriteMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, immutableWriteRecipe, "mysql")
}

// TestRecipeImmutableWritePostgres runs the immutable_write recipe on Postgres, each case on a case database (FCV-3).
// Requirements: DBS-84.
func TestRecipeImmutableWritePostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, immutableWriteRecipe, "postgres")
}

// TestRecipeImmutableWriteSqlite runs the immutable_write recipe on Sqlite, each case on a case database (FCV-3).
// Requirements: DBS-84.
func TestRecipeImmutableWriteSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, immutableWriteRecipe, "sqlite")
}

// TestRecipeImmutableWriteMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeImmutableWriteMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, immutableWriteRecipe, "markdown")
}
