package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

const externalAuditRecipe = "../../../contracts/fixtures/external_audit/external_audit.json"

// TestRecipeExternalAuditMysql runs the external_audit recipe on Mysql, each case on a case database (FCV-3).
// Requirements: SCH-14, DBS-110.
func TestRecipeExternalAuditMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, externalAuditRecipe, "mysql")
}

// TestRecipeExternalAuditMariadb runs the external_audit recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeExternalAuditMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, externalAuditRecipe, "mariadb")
}

// TestRecipeExternalAuditPostgres runs the external_audit recipe on Postgres, each case on a case database (FCV-3).
// Requirements: SCH-14, DBS-110.
func TestRecipeExternalAuditPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, externalAuditRecipe, "postgres")
}

// TestRecipeExternalAuditSqlite runs the external_audit recipe on Sqlite, each case on a case database (FCV-3).
// Requirements: SCH-14, DBS-110.
func TestRecipeExternalAuditSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, externalAuditRecipe, "sqlite")
}

// TestRecipeExternalAuditMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeExternalAuditMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, externalAuditRecipe, "markdown")
}
