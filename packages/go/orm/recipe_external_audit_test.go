package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

const externalAuditRecipe = "../../../contracts/fixtures/external_audit/external_audit.json"

// TestRecipeExternalAuditMysql runs the external_audit recipe on Mysql, each case on a case database (FCV-3).
// Requirements: SCH-14, DBS-110.
func TestRecipeExternalAuditMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, externalAuditRecipe, "mysql")
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
