package model_test

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// refusalChain is one use of the refusals of the case errors of the recipe conformance_verification, as source for the
// type checker. The spec makes each of them a returned error (DSL-19, DSL-47, DSL-10, DSL-123, DSL-98, DSL-67, DSL-96,
// PRT-14), so the type checker accepts the chain and refuses only a use that drops that error. The refusals themselves
// run in the recipe.
type refusalChain struct {
	name   string
	source string
}

var refusalChains = []refusalChain{
	{"missing connector", `author().Name("a").IsClose(true).Gets()`},
	{"dangling connector", `author().Name("a").And().Gets()`},
	{"empty list", `author().Seq([]int64{}).Gets()`},
	{"no connection", `model.Author().Name("a").Gets()`},
	{"lock outside a transaction", `author().ForUpdate().Gets()`},
	{"join child with connection", `author().JoinUserSeqWithSeq(model.User().Connect(db)).Gets()`},
	{"page with limit", `author().Limit(0, 1).GetsPage(1, 10)`},
	{"relation with limit", `author().Relation(model.User().MatchUserSeqWithSeq().Limit(0, 1)).GetsBySeq(42)`},
	{"unjoined model placement", `author().Name("a").Or(model.User()).Gets()`},
}

// TestRefusalIsATypedError is the build fixture of the refusals of the case errors: the type checker accepts each chain with its error
// and refuses the use that drops the error, so the refusal cannot be left unread.
// Requirements: DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
func TestRefusalIsATypedError(t *testing.T) {
	testcase.Start(t)
	imported := loadModelTypes(t)
	check := func(t *testing.T, body string) []string {
		t.Helper()
		src := "package snippet\n\nimport (\n\t\"" + modelPath + "\"\n\t\"" + ormPath + "\"\n)\n\nfunc use(db *orm.DB) {\n\tauthor := func() *model.AuthorModel { return model.Author().Connect(db) }\n\t_ = author\n\t" + body + "\n}\n"
		return checkSnippet(t, imported, src)
	}
	for _, chain := range refusalChains {
		t.Run(chain.name, func(t *testing.T) {
			if errs := check(t, "rows, err := "+chain.source+"\n\t_, _ = rows, err"); len(errs) != 0 {
				t.Fatalf("%s does not compile with its error: %s", chain.source, strings.Join(errs, "; "))
			}
			errs := check(t, "rows := "+chain.source+"\n\t_ = rows")
			if len(errs) != 1 || !strings.Contains(errs[0], "assignment mismatch") {
				t.Fatalf("a use of %s that drops its error must be refused as an assignment mismatch, got %q", chain.source, errs)
			}
		})
	}
}
