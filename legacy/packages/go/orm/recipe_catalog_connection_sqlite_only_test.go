package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// catalogConnectionSqliteOnlyRecipe is the recipe of the cases that run on SQLite only, relative to this package directory.
var catalogConnectionSqliteOnlyRecipe = testcase.LegacyPath("contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json")

// TestRecipeCatalogConnectionSqliteOnly runs the SQLite-only cases of the catalog_connection recipe on SQLite (FCV-3).
func TestRecipeCatalogConnectionSqliteOnly(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, catalogConnectionSqliteOnlyRecipe, "sqlite")
}

// TestRecipeCatalogConnectionSqliteOnlyMarkdown runs the SQLite-only cases on flowmark, whose connection is a SQLite
// connection (FCV-3).
func TestRecipeCatalogConnectionSqliteOnlyMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, catalogConnectionSqliteOnlyRecipe, "markdown")
}
