package orm_test

// Requirements: CFG-33, INT-87, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// constraintsAndRelationsRecipe is the recipe of the constraints and relations, relative to this package directory.
const constraintsAndRelationsRecipe = "../../../contracts/fixtures/constraints_and_relations/constraints_and_relations.json"

// TestRecipeConstraintsAndRelationsMysql runs the constraints_and_relations recipe on MySQL, each case on a case database (FCV-3).
// Requirements: CFG-33, INT-87.
func TestRecipeConstraintsAndRelationsMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, constraintsAndRelationsRecipe, "mysql")
}

// TestRecipeConstraintsAndRelationsMariadb runs the constraints_and_relations recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeConstraintsAndRelationsMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, constraintsAndRelationsRecipe, "mariadb")
}

// TestRecipeConstraintsAndRelationsPostgres runs the constraints_and_relations recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: CFG-33, INT-87.
func TestRecipeConstraintsAndRelationsPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, constraintsAndRelationsRecipe, "postgres")
}

// TestRecipeConstraintsAndRelationsSqlite runs the constraints_and_relations recipe on SQLite, each case on a case database (FCV-3).
// Requirements: CFG-33, INT-87.
func TestRecipeConstraintsAndRelationsSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, constraintsAndRelationsRecipe, "sqlite")
}

// TestRecipeConstraintsAndRelationsMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeConstraintsAndRelationsMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, constraintsAndRelationsRecipe, "markdown")
}
