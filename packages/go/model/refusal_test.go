package model_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"strings"
	"testing"

	"golang.org/x/tools/go/packages"

	"github.com/polyspec/orm/packages/go/testcase"
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
	testcase.Start(t, testcase.Compute)
	const modelPath = "github.com/polyspec/orm/packages/go/model"
	const ormPath = "github.com/polyspec/orm/packages/go/orm"
	loaded, err := packages.Load(&packages.Config{Mode: packages.NeedName | packages.NeedTypes | packages.NeedImports | packages.NeedDeps}, modelPath, ormPath)
	if err != nil {
		t.Fatal(err)
	}
	imported := map[string]*types.Package{}
	for _, p := range loaded {
		if len(p.Errors) > 0 {
			t.Fatalf("load %s: %v", p.PkgPath, p.Errors)
		}
		imported[p.PkgPath] = p.Types
	}
	check := func(body string) []string {
		src := "package snippet\n\nimport (\n\t\"" + modelPath + "\"\n\t\"" + ormPath + "\"\n)\n\nfunc use(db *orm.DB) {\n\tauthor := func() *model.AuthorModel { return model.Author().Connect(db) }\n\t_ = author\n\t" + body + "\n}\n"
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, "snippet.go", src, 0)
		if err != nil {
			t.Fatal(err)
		}
		var errs []string
		conf := types.Config{
			Importer: importerFunc(func(path string) (*types.Package, error) { return imported[path], nil }),
			Error:    func(err error) { errs = append(errs, err.Error()) },
		}
		// Check returns the first error that Error collects, so the list holds every error.
		_, _ = conf.Check("snippet", fset, []*ast.File{file}, nil)
		return errs
	}
	for _, chain := range refusalChains {
		t.Run(chain.name, func(t *testing.T) {
			if errs := check("rows, err := " + chain.source + "\n\t_, _ = rows, err"); len(errs) != 0 {
				t.Fatalf("%s does not compile with its error: %s", chain.source, strings.Join(errs, "; "))
			}
			errs := check("rows := " + chain.source + "\n\t_ = rows")
			if len(errs) != 1 || !strings.Contains(errs[0], "assignment mismatch") {
				t.Fatalf("a use of %s that drops its error must be refused as an assignment mismatch, got %q", chain.source, errs)
			}
		})
	}
}
