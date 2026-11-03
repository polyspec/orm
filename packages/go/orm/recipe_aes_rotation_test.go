// Recipe conversion of the AES key-version codes and rotation: FCV-4 (model.connect with aes_keyring, aes.status
// and aes.rotate, and sql.exec for the stored version type of a case), FCV-8 to FCV-14 (docs/spec/feature-coverage.md).
package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// aesRotationRecipe is the recipe of the AES rotation, relative to this package directory.
const aesRotationRecipe = "../../../contracts/fixtures/aes_rotation/aes_rotation.json"

// TestRecipeAesRotationMysql runs the aes_rotation recipe on MySQL, each case on a case database (FCV-3).
// Requirements: COD-44, COD-47, COD-49 to COD-54, COD-57 to COD-60, INT-75.
func TestRecipeAesRotationMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, aesRotationRecipe, "mysql")
}

// TestRecipeAesRotationPostgres runs the aes_rotation recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: COD-44, COD-47, COD-49 to COD-54, COD-57 to COD-60, INT-75.
func TestRecipeAesRotationPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, aesRotationRecipe, "postgres")
}

// TestRecipeAesRotationSqlite runs the aes_rotation recipe on SQLite, each case on a case database (FCV-3).
// Requirements: COD-44, COD-47, COD-49 to COD-54, COD-57 to COD-60, INT-75.
// INT-152: on SQLite a text stored in an INTEGER or REAL column is a text grid cell; the recipe expects it at step 16 of read_path_codes, rotation_path_codes and stored_version_text. Requirement: INT-152.
func TestRecipeAesRotationSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, aesRotationRecipe, "sqlite")
}
