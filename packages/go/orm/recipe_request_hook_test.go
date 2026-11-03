// Recipe conversion of the request hook: FCV-8, FCV-9, FCV-10,
// FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// requestHookRecipe is the recipe of the request hook, relative to this package directory.
const requestHookRecipe = "../../../contracts/fixtures/request_hook/request_hook.json"

// TestRecipeRequestHookMysql runs the request_hook recipe on MySQL, each case on a case database (FCV-3).
// Requirements: PRT-65, INT-78, PRT-2, PRT-4, PRT-5, PRT-6, PRT-41, CFG-21, INT-36, INT-37, PLN-16, DIA-161, INT-38.
func TestRecipeRequestHookMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, requestHookRecipe, "mysql")
}

// TestRecipeRequestHookPostgres runs the request_hook recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: PRT-65, INT-78, PRT-2, PRT-4, PRT-5, PRT-6, PRT-41, CFG-21, INT-36, INT-37, PLN-16, DIA-161, INT-38.
func TestRecipeRequestHookPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, requestHookRecipe, "postgres")
}

// TestRecipeRequestHookSqlite runs the request_hook recipe on SQLite, each case on a case database (FCV-3).
// Requirements: PRT-65, INT-78, PRT-2, PRT-4, PRT-5, PRT-6, PRT-41, CFG-21, INT-36, INT-37, PLN-16, DIA-161, INT-38.
func TestRecipeRequestHookSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, requestHookRecipe, "sqlite")
}
