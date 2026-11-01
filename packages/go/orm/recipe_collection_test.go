package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// collectionRecipe is the recipe of the collection and page reads, relative to this package directory.
const collectionRecipe = "../../../tests/collection/collection.json"

// TestRecipeCollectionMysql runs the collection recipe on MySQL, each case on a case database (FCV-3).
// Requirements: INT-30, INT-31, INT-32, INT-33, INT-35, INT-81, INT-82, INT-84.
func TestRecipeCollectionMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, collectionRecipe, "mysql")
}

// TestRecipeCollectionPostgres runs the collection recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: INT-30, INT-31, INT-32, INT-33, INT-35, INT-81, INT-82, INT-84.
func TestRecipeCollectionPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, collectionRecipe, "postgres")
}

// TestRecipeCollectionSqlite runs the collection recipe on SQLite, each case on a case database (FCV-3).
// Requirements: INT-30, INT-31, INT-32, INT-33, INT-35, INT-81, INT-82, INT-84.
func TestRecipeCollectionSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, collectionRecipe, "sqlite")
}
