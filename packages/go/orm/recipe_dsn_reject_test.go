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

// TestRecipeDsnRejectCheckedNone runs the refusals of the runtimes that check the TLS options and hold a negative
// configuration, contracts/fixtures/dsn_reject/dsn_reject_checked.json. Rust passes the options to its driver (CFG-18)
// and its fields are unsigned (CFG-4, CFG-5, CFG-6).
// Requirements: CFG-4, CFG-5, CFG-6, CFG-18, CFG-34.
func TestRecipeDsnRejectCheckedNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../contracts/fixtures/dsn_reject/dsn_reject_checked.json", recipe.None)
}
