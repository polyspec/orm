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

// TestChainArgumentTypes type-checks calls of generated chain methods against the generated model, as the compiler
// does: the value types that a chain accepts are the type parameters of its method. The test of DSL-49 (Go rejects
// null for a non-null column at compile time), DSL-50 (lists and null only without an operator, with Eq and with Ne)
// and DSL-52 (an integer column accepts int, int32, int64 and slices of those types) (docs/spec/dsl.md).
func TestChainArgumentTypes(t *testing.T) {
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
	for _, c := range []struct {
		call   string
		accept bool
	}{
		// DSL-52: an integer column takes int, int32, int64 and their slices.
		{"Seq(int(1))", true},
		{"Seq(int32(1))", true},
		{"Seq(int64(1))", true},
		{"Seq([]int{1, 2})", true},
		{"Seq([]int32{1, 2})", true},
		{"Seq([]int64{1, 2})", true},
		{`Seq("1")`, false},
		{"Seq(1.5)", false},
		// DSL-49: null only for a nullable column.
		{"PhotoUrl(orm.Null)", true},
		{"Seq(orm.Null)", false},
		// DSL-50: a list only without an operator, with Eq and with Ne; another operator takes neither a list nor null.
		{"AndGtReadCount(1)", true},
		{"AndGtReadCount([]int{1, 2})", false},
		{"AndGtReadCount(orm.Null)", false},
		{"AndBetweenReadCount([2]int{1, 2})", true},
		{"AndBetweenReadCount([]int{1, 2})", false},
	} {
		t.Run(c.call, func(t *testing.T) {
			src := "package snippet\n\nimport (\n\t\"" + modelPath + "\"\n\t\"" + ormPath + "\"\n)\n\nvar _ = orm.Null\n\nfunc use() { model.Author()." + c.call + " }\n"
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
			conf.Check("snippet", fset, []*ast.File{file}, nil)
			if c.accept && len(errs) > 0 {
				t.Fatalf("model.Author().%s does not compile: %s", c.call, strings.Join(errs, "; "))
			}
			if !c.accept && len(errs) == 0 {
				t.Fatalf("model.Author().%s compiles; the chain must reject its argument", c.call)
			}
		})
	}
}

// importerFunc imports the packages that the test loaded.
type importerFunc func(path string) (*types.Package, error)

func (f importerFunc) Import(path string) (*types.Package, error) { return f(path) }
