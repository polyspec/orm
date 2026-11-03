package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// dsnConnectionRecipe is the recipe of the DSN connection, relative to this package directory.
const dsnConnectionRecipe = "../../../contracts/fixtures/dsn_connection/dsn_connection.json"

// TestRecipeDsnConnectionMysql runs the dsn_connection recipe on MySQL, each case on a case database (FCV-3).
// Requirements: CFG-1, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, CFG-19, CFG-2, CFG-26, CFG-16, DIA-57, DSL-141, CFG-27, CFG-28, CFG-29, CFG-6, CFG-12, CFG-13, CFG-21, CFG-22, CFG-23, CFG-25, CFG-24.
func TestRecipeDsnConnectionMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dsnConnectionRecipe, "mysql")
}

// TestRecipeDsnConnectionPostgres runs the dsn_connection recipe on PostgreSQL (FCV-3).
// Requirements: CFG-1.
func TestRecipeDsnConnectionPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dsnConnectionRecipe, "postgres")
}

// TestRecipeDsnConnectionSqlite runs the dsn_connection recipe on SQLite (FCV-3).
// Requirements: CFG-1.
func TestRecipeDsnConnectionSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dsnConnectionRecipe, "sqlite")
}
