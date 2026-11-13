package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeDsnRejectNone runs the refused DSN recipe, contracts/fixtures/dsn_reject/dsn_reject.json, without a database (FCV-3).
// Requirements: CFG-2, CFG-17, CFG-19, CFG-26, FCV-15, PRT-64.
func TestRecipeDsnRejectNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../contracts/fixtures/dsn_reject/dsn_reject.json", recipe.None)
}

// TestRecipeDsnRejectCheckedNone runs the refusals of the TLS options, which every runtime checks (CFG-18), and of a
// negative configuration, which Go holds in signed fields while Rust holds it in unsigned ones (CFG-4, CFG-5, CFG-6),
// contracts/fixtures/dsn_reject/dsn_reject_checked.json.
// Requirements: CFG-4, CFG-5, CFG-6, CFG-18, CFG-36.
func TestRecipeDsnRejectCheckedNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../contracts/fixtures/dsn_reject/dsn_reject_checked.json", recipe.None)
}

// TestRecipeDsnRejectParametersNone runs the refusals of a parameter that the scheme does not accept and of each form of
// the query rule, contracts/fixtures/dsn_reject/dsn_reject_parameters.json, without a database (FCV-3).
// Requirements: CFG-12, CFG-19, CFG-20, CFG-37, INT-187.
func TestRecipeDsnRejectParametersNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../contracts/fixtures/dsn_reject/dsn_reject_parameters.json", recipe.None)
}
