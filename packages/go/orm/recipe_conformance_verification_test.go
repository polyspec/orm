// Requirements: DSL-54, DSL-99, DSL-137, DSL-139, DSL-144, DIA-11, DIA-14, PRT-77.
package orm_test

// Requirements: FCV-2, FCV-3, FCV-4, DBS-115, DIA-11, DIA-14, DIA-24, DIA-37, DSL-137, DSL-139, DSL-144, INT-39.

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// conformanceVerificationRecipe is the recipe of the conformance chains, relative to this package directory.
const conformanceVerificationRecipe = "../../../contracts/fixtures/conformance_verification/conformance_verification.json"

// TestRecipeConformanceVerificationMysql runs the conformance_verification recipe on MySQL, each case on a case database (FCV-3).
func TestRecipeConformanceVerificationMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, conformanceVerificationRecipe, "mysql")
}

// TestRecipeConformanceVerificationPostgres runs the conformance_verification recipe on PostgreSQL, each case on a case database (FCV-3).
func TestRecipeConformanceVerificationPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, conformanceVerificationRecipe, "postgres")
}

// TestRecipeConformanceVerificationSqlite runs the conformance_verification recipe on SQLite, each case on a case database (FCV-3).
func TestRecipeConformanceVerificationSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, conformanceVerificationRecipe, "sqlite")
}
