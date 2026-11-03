package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// transactionsRecipe is the recipe of the transaction behaviour, relative to this package directory.
const transactionsRecipe = "../../../contracts/fixtures/transactions/transactions.json"

// TestRecipeTransactionsMysql runs the transactions recipe on MySQL, each case on a case database (FCV-3).
// Requirements: CFG-24, DSL-118, DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-49,
// INT-48, PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, PLN-24, PLN-44.
func TestRecipeTransactionsMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, transactionsRecipe, "mysql")
}

// TestRecipeTransactionsPostgres runs the transactions recipe on PostgreSQL, each case on a case database (FCV-3).
// Requirements: CFG-24, DSL-118, DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-49,
// INT-48, PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, PLN-24, PLN-44.
func TestRecipeTransactionsPostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, transactionsRecipe, "postgres")
}

// TestRecipeTransactionsSqlite runs the transactions recipe on SQLite, each case on a case database (FCV-3).
// Requirements: CFG-24, DSL-118, DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-49,
// INT-48, PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, PLN-24, PLN-44.
func TestRecipeTransactionsSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, transactionsRecipe, "sqlite")
}
