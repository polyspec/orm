package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// performanceGateRecipe is the correctness recipe of the hot-path performance gate, relative to this package directory.
const performanceGateRecipe = "../../../contracts/fixtures/performance_gate/performance_gate.json"

// TestRecipePerformanceGateMysql runs the performance_gate recipe on MySQL, each case on a case database (FCV-3).
// Requirements: PERF-1.
func TestRecipePerformanceGateMysql(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, performanceGateRecipe, "mysql")
}

// TestRecipePerformanceGatePostgres runs the performance_gate recipe on PostgreSQL (FCV-3).
// Requirements: PERF-1.
func TestRecipePerformanceGatePostgres(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, performanceGateRecipe, "postgres")
}

// TestRecipePerformanceGateSqlite runs the performance_gate recipe on SQLite (FCV-3).
// Requirements: PERF-1.
func TestRecipePerformanceGateSqlite(t *testing.T) {
	testcase.Group(t)
	recipe.Run(t, performanceGateRecipe, "sqlite")
}
