package bindmessages_test

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/bindmodel"
	"github.com/polyspec/orm/legacy/packages/go/engine/ir"
	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipePublicInterfaceSignedNone runs the case of the signed limit, which Rust refuses at compile time, without a database
// (FCV-3, FCV-4). The builder runs on a model with no connection: the terminal returns the first error before it resolves one, so
// no statement can be sent.
// Requirements: INT-159.
func TestRecipePublicInterfaceSignedNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../contracts/fixtures/public_interface/public_interface_signed.json", recipe.None, recipe.WithMarkdownBuilder(func(t *testing.T, calls []string) (string, string) {
		t.Helper()
		model := bindmodel.Slots()
		for _, call := range calls {
			switch call {
			case "limit_negative_offset":
				model = model.Limit(-1, 1)
			case "limit_zero_count":
				model = model.Limit(0, 0)
			default:
				t.Fatalf("markdown.builder call %s has no builder call in this Go case", call)
			}
		}
		_, err := model.GetCount()
		var e *ir.Error
		if !errors.As(err, &e) {
			t.Fatalf("the terminal returned %v, want an orm error", err)
		}
		return e.Code, e.Error()
	}))
}
