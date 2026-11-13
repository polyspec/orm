package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// transactionsRecipe is the recipe of the transaction behaviour, relative to this package directory.
const transactionsRecipe = "../../../contracts/fixtures/transactions/transactions.json"

// TestRecipeTransactionsMysql runs the transactions recipe on MySQL, each case on a case database (FCV-3).
// Requirements: CFG-15, CFG-24, INT-155, DSL-118, DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-72,, CFG-12
// INT-48, INT-49, PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, PLN-24, PLN-44.
func TestRecipeTransactionsMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, transactionsRecipe, "mysql")
}

// TestRecipeTransactionsMariadb runs the transactions recipe on MariaDB, a server of the MySQL dialect, each case on a case
// database (DIA-200, FCV-3).
func TestRecipeTransactionsMariadb(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, transactionsRecipe, "mariadb")
}

// TestRecipeTransactionsPostgres runs the transactions recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: CFG-24, DSL-118, DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-72,
// INT-48, INT-49, PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, PLN-24, PLN-44.
func TestRecipeTransactionsPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, transactionsRecipe, "postgres")
}

// TestRecipeTransactionsSqlite runs the transactions recipe on SQLite, each case on a case database (FCV-3).
// Requirements: CFG-24, DSL-118, DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-72,
// INT-48, INT-49, PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, PLN-24, PLN-44.
func TestRecipeTransactionsSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, transactionsRecipe, "sqlite")
}

// TestRecipeTransactionsMarkdown runs the recipe on flowmark, each case on a corpus of its own (FCV-3).
func TestRecipeTransactionsMarkdown(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, transactionsRecipe, "markdown")
}
