package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeDsnRejectNone runs the refused DSN recipe, contracts/fixtures/dsn_reject/dsn_reject.json, without a database (FCV-3).
// Requirements: CFG-2, CFG-17, CFG-19, CFG-26, FCV-15.
func TestRecipeDsnRejectNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../contracts/fixtures/dsn_reject/dsn_reject.json", recipe.None)
}
