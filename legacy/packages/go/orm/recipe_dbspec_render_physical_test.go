// Requirements: DIA-113, FCV-3, FCV-4 (docs/spec/feature-coverage.md).
package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// dbspecRenderPhysicalRecipe is the recipe of the rendered statements, relative to this package directory.
const dbspecRenderPhysicalRecipe = "../../../tests/dbspec/render-physical.json"

// TestRecipeDbspecRenderPhysicalMysql runs the rendered statements of tests/dbspec/ddl.json and their behavior steps on mysql.
// Requirements: DIA-113.
func TestRecipeDbspecRenderPhysicalMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecRenderPhysicalRecipe, "mysql")
}

// TestRecipeDbspecRenderPhysicalMariadb runs the dbspec_render_physical recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeDbspecRenderPhysicalMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecRenderPhysicalRecipe, "mariadb")
}

// TestRecipeDbspecRenderPhysicalPostgres runs the rendered statements of tests/dbspec/ddl.json and their behavior steps on postgres.
// Requirements: DIA-113.
func TestRecipeDbspecRenderPhysicalPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecRenderPhysicalRecipe, "postgres")
}

// TestRecipeDbspecRenderPhysicalSqlite runs the rendered statements of tests/dbspec/ddl.json and their behavior steps on sqlite.
// Requirements: DIA-113.
func TestRecipeDbspecRenderPhysicalSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecRenderPhysicalRecipe, "sqlite")
}

// TestRecipeDbspecRenderPhysicalMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeDbspecRenderPhysicalMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecRenderPhysicalRecipe, "markdown")
}
