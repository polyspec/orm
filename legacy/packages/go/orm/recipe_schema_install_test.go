package orm_test

// Requirements: SCH-13
// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, DBS-104, DBS-107, DBS-108, DBS-119, DBS-120, INT-54, INT-55, INT-132, INT-133, PLN-44, SCH-7, SCH-10, SCH-11, INT-56, INT-57, INT-58, SCH-8, SCH-9

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// schemaInstallRecipe is the recipe of schema installation, relative to this package directory.
const schemaInstallRecipe = "../../../contracts/fixtures/schema_install/schema_install.json"

// TestRecipeSchemaInstallMysql runs the schema_install recipe on MySQL, each case on an empty case database (FCV-3).
// Requirements: DBS-104, DBS-107, DBS-108, DBS-119, DBS-120, INT-54, INT-55, INT-132, INT-133, PLN-44, SCH-7, SCH-10, SCH-11., INT-56, INT-57, INT-58, SCH-8, SCH-9
func TestRecipeSchemaInstallMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, schemaInstallRecipe, "mysql")
}

// TestRecipeSchemaInstallMariadb runs the schema_install recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeSchemaInstallMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, schemaInstallRecipe, "mariadb")
}

// TestRecipeSchemaInstallPostgres runs the schema_install recipe on PostgreSQL (FCV-3).
// Requirements: DBS-104, DBS-107, DBS-108, DBS-119, DBS-120, INT-54, INT-55, INT-132, INT-133, PLN-44, SCH-7, SCH-10, SCH-11., INT-56, INT-57, INT-58, SCH-8, SCH-9
func TestRecipeSchemaInstallPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, schemaInstallRecipe, "postgres")
}

// TestRecipeSchemaInstallSqlite runs the schema_install recipe on SQLite (FCV-3).
// Requirements: DBS-104, DBS-107, DBS-108, DBS-119, DBS-120, INT-54, INT-55, INT-132, INT-133, PLN-44, SCH-7, SCH-10, SCH-11., INT-56, INT-57, INT-58, SCH-8, SCH-9
func TestRecipeSchemaInstallSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, schemaInstallRecipe, "sqlite")
}

// TestRecipeSchemaInstallMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeSchemaInstallMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, schemaInstallRecipe, "markdown")
}
