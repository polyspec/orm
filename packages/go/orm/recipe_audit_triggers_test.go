package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// auditTriggersRecipe is the recipe of the audit transactions and their triggers, relative to this package directory.
const auditTriggersRecipe = "../../../contracts/fixtures/audit_triggers/audit_triggers.json"

// TestRecipeAuditTriggersMysql runs the audit_triggers recipe on MySQL, each case on a case database (FCV-3).
// Requirements: CFG-8, DBS-67, DBS-85, DBS-87, DBS-88, DBS-89, DBS-93, DBS-94, DBS-96, DBS-117, DIA-161, DSL-118, DSL-119,
// DSL-126, INT-38, INT-44.
func TestRecipeAuditTriggersMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, auditTriggersRecipe, "mysql")
}

// TestRecipeAuditTriggersPostgres runs the audit_triggers recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: CFG-8, DBS-67, DBS-85, DBS-87, DBS-88, DBS-89, DBS-93, DBS-94, DBS-96, DBS-117, DIA-161, DSL-118, DSL-119,
// DSL-126, INT-38, INT-44.
func TestRecipeAuditTriggersPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, auditTriggersRecipe, "postgres")
}

// TestRecipeAuditTriggersSqlite runs the audit_triggers recipe on SQLite, each case on a case database (FCV-3).
// Requirements: CFG-8, DBS-67, DBS-85, DBS-87, DBS-88, DBS-89, DBS-93, DBS-94, DBS-96, DBS-117, DIA-161, DSL-118, DSL-119,
// DSL-126, INT-38, INT-44.
func TestRecipeAuditTriggersSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, auditTriggersRecipe, "sqlite")
}

// TestRecipeAuditTriggersMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeAuditTriggersMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, auditTriggersRecipe, "markdown")
}
