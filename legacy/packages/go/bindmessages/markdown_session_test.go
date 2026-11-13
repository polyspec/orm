package bindmessages_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/bindmodel"
	"github.com/polyspec/orm/legacy/packages/go/internal/recipe"
	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestRecipeMarkdownSessionNone runs the session recipe, tests/markdown/session.json, without a database (FCV-3, FCV-4): each
// markdown.session step runs reads of the bind fixture model on a listener that answers from its replies.
// Requirements: PRT-66.
func TestRecipeMarkdownSessionNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, testcase.LegacyPath("tests/markdown/session.json"), recipe.None, recipe.WithMarkdownRead(recipe.MarkdownRead{
		Connect: bindmodel.Connect,
		Read: func(db *orm.DB) error {
			_, err := bindmodel.Slots().Connect(db).Gets()
			return err
		},
	}))
}
