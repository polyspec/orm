package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// catalogConnectionRecipe is the recipe of the live catalog connection, relative to this package directory.
const catalogConnectionRecipe = "../../../contracts/fixtures/catalog_connection/catalog_connection.json"

// TestRecipeCatalogConnectionMysql runs the catalog_connection recipe on MySQL, each case on a case database (FCV-3).
// Requirements: INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123,
// INT-136, SCH-6a.
func TestRecipeCatalogConnectionMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, catalogConnectionRecipe, "mysql")
}

// TestRecipeCatalogConnectionPostgres runs the catalog_connection recipe on PostgreSQL, each case on a case database
// (FCV-3).
// Requirements: INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123,
// INT-136, SCH-6a.
func TestRecipeCatalogConnectionPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, catalogConnectionRecipe, "postgres")
}

// TestRecipeCatalogConnectionSqlite runs the catalog_connection recipe on SQLite, each case on a case database (FCV-3).
// Requirements: INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123,
// INT-136, SCH-6a.
func TestRecipeCatalogConnectionSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, catalogConnectionRecipe, "sqlite")
}
