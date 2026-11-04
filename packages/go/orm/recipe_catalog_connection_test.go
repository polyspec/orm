package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// catalogConnectionRecipe is the recipe of the live catalog connection, relative to this package directory.
const catalogConnectionRecipe = "../../../contracts/fixtures/catalog_connection/catalog_connection.json"

// catalogConnectionSqliteOnlyRecipe is the recipe of the cases that run on SQLite only, relative to this package directory.
const catalogConnectionSqliteOnlyRecipe = "../../../contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json"

// TestRecipeCatalogConnectionMysql runs the catalog_connection recipe on MySQL, each case on a case database (FCV-3).
// Requirements: INT-107, INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123,
// INT-136, SCH-6a.
// Requirements: DBS-113, INT-34, INT-102, INT-106, INT-108, INT-110, INT-112, SCH-5.
// Requirements: SCH-3.
// Requirements: COD-31, INT-4, INT-8, INT-97.
// Requirements: INT-119, INT-121.
func TestRecipeCatalogConnectionMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, catalogConnectionRecipe, "mysql")
}

// TestRecipeCatalogConnectionPostgres runs the catalog_connection recipe on PostgreSQL, each case on a case database
// (FCV-3).
// Requirements: INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123,
// INT-136, SCH-6a.
// Requirements: DBS-113, INT-34, INT-102, INT-106, INT-108, INT-110, INT-112, SCH-5.
// Requirements: COD-31, INT-4, INT-8, INT-97.
// Requirements: INT-119, INT-121.
func TestRecipeCatalogConnectionPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, catalogConnectionRecipe, "postgres")
}

// TestRecipeCatalogConnectionSqlite runs the catalog_connection recipe on SQLite, each case on a case database (FCV-3).
// Requirements: INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123,
// INT-136, SCH-6a.
// Requirements: DBS-113, INT-34, INT-102, INT-106, INT-108, INT-110, INT-112, SCH-5.
// Requirements: COD-31, INT-4, INT-8, INT-97.
// Requirements: INT-119, INT-121.
func TestRecipeCatalogConnectionSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, catalogConnectionRecipe, "sqlite")
}

// TestRecipeCatalogConnectionSqliteOnly runs the SQLite-only cases of the catalog_connection recipe on SQLite (FCV-3).
func TestRecipeCatalogConnectionSqliteOnly(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, catalogConnectionSqliteOnlyRecipe, "sqlite")
}
