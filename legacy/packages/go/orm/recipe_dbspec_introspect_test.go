package orm_test

// Requirements: PLN-102
// Requirements: DBS-42, DBS-84, DBS-94, DIA-110, DIA-111, DIA-112, DIA-133, DIA-134, DIA-135, DIA-136, DIA-137
// Requirements: DIA-138, DIA-139, DIA-140, DIA-141, DIA-142, DIA-143, DIA-144, DIA-145, DIA-146, DIA-147, DIA-148
// Requirements: DIA-149, DIA-150, DIA-151, DIA-152, DIA-153, DIA-198, DIA-39, DIA-44, DIA-49, DIA-50, DIA-59, DIA-71
// Requirements: FCV-2

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// dbspecIntrospectRecipe is the recipe of the introspection round trip, relative to this package directory.
const dbspecIntrospectRecipe = "../../../contracts/fixtures/dbspec_introspect/dbspec_introspect.json"

// TestRecipeDbspecIntrospectMysql runs the dbspec_introspect recipe on MySQL, each case on an empty case database (FCV-3).
// Requirements: DBS-42, DBS-84, DBS-94, DIA-110, DIA-111, DIA-112, DIA-133, DIA-134, DIA-135, DIA-136, DIA-137
// Requirements: DIA-138, DIA-139, DIA-140, DIA-141, DIA-142, DIA-143, DIA-144, DIA-145, DIA-146, DIA-147, DIA-148
// Requirements: DIA-149, DIA-150, DIA-151, DIA-152, DIA-153, DIA-198, DIA-39, DIA-44, DIA-49, DIA-50, DIA-59, DIA-71
// Requirements: FCV-2
func TestRecipeDbspecIntrospectMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecIntrospectRecipe, "mysql")
}

// TestRecipeDbspecIntrospectMariadb runs the dbspec_introspect recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeDbspecIntrospectMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecIntrospectRecipe, "mariadb")
}

// TestRecipeDbspecIntrospectPostgres runs the dbspec_introspect recipe on PostgreSQL (FCV-3).
// Requirements: DBS-42, DBS-84, DBS-94, DIA-110, DIA-111, DIA-112, DIA-133, DIA-134, DIA-135, DIA-136, DIA-137
// Requirements: DIA-138, DIA-139, DIA-140, DIA-141, DIA-142, DIA-143, DIA-144, DIA-145, DIA-146, DIA-147, DIA-148
// Requirements: DIA-149, DIA-150, DIA-151, DIA-152, DIA-153, DIA-198, DIA-39, DIA-44, DIA-49, DIA-50, DIA-59, DIA-71
// Requirements: FCV-2
func TestRecipeDbspecIntrospectPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecIntrospectRecipe, "postgres")
}

// TestRecipeDbspecIntrospectSqlite runs the dbspec_introspect recipe on SQLite (FCV-3).
// Requirements: DBS-42, DBS-84, DBS-94, DIA-110, DIA-111, DIA-112, DIA-133, DIA-134, DIA-135, DIA-136, DIA-137
// Requirements: DIA-138, DIA-139, DIA-140, DIA-141, DIA-142, DIA-143, DIA-144, DIA-145, DIA-146, DIA-147, DIA-148
// Requirements: DIA-149, DIA-150, DIA-151, DIA-152, DIA-153, DIA-198, DIA-39, DIA-44, DIA-49, DIA-50, DIA-59, DIA-71
// Requirements: FCV-2
func TestRecipeDbspecIntrospectSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecIntrospectRecipe, "sqlite")
}

// TestRecipeDbspecIntrospectMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeDbspecIntrospectMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, dbspecIntrospectRecipe, "markdown")
}
