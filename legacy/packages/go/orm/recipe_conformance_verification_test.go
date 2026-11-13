// Requirements: DSL-54, DSL-99, DSL-137, DSL-139, DSL-144, DIA-11, DIA-14, PRT-77, DIA-24, DIA-18, DIA-56.
package orm_test

// Requirements: FCV-2, FCV-3, FCV-4, DBS-115, DIA-11, DIA-14, DIA-24, DIA-37, DSL-137, DSL-139, DSL-144, INT-39.

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// conformanceVerificationRecipe is the recipe of the conformance chains, relative to this package directory.
var conformanceVerificationRecipe = testcase.LegacyPath("contracts/fixtures/conformance_verification/conformance_verification.json")

// TestRecipeConformanceVerificationMysql runs the conformance_verification recipe on MySQL, each case on a case database (FCV-3).
func TestRecipeConformanceVerificationMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, conformanceVerificationRecipe, "mysql")
}

// TestRecipeConformanceVerificationMariadb runs the conformance_verification recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeConformanceVerificationMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, conformanceVerificationRecipe, "mariadb")
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

// TestRecipeConformanceVerificationMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeConformanceVerificationMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, conformanceVerificationRecipe, "markdown")
}
