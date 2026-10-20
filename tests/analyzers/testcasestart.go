package analyzers

import (
	"go/ast"
	"go/types"
	"strings"

	"golang.org/x/tools/go/analysis"
)

// TestCasePackage is the package of the shared case report of the Go tests.
const TestCasePackage = "github.com/polyspec/orm/packages/go/testcase"

// TestCaseStart reports each Test or Fuzz function of a test file that does not start its case with
// packages/go/testcase (testcase.Start, Group, Run or Of): such a test runs without a RUN line and a deadline. The tests of
// packages/go/testcase itself, which define that report, are not checked.
var TestCaseStart = &analysis.Analyzer{
	Name: "testcasestart",
	Doc:  "reports a Test or Fuzz function that does not start its case with packages/go/testcase",
	Run:  runTestCaseStart,
}

// testing reports whether parameters is the one *testing.T or *testing.F of a Test or Fuzz function.
func testing(pass *analysis.Pass, parameters *ast.FieldList) bool {
	if parameters == nil || len(parameters.List) != 1 || len(parameters.List[0].Names) > 1 {
		return false
	}
	pointer, ok := pass.TypesInfo.TypeOf(parameters.List[0].Type).(*types.Pointer)
	if !ok {
		return false
	}
	named, ok := pointer.Elem().(*types.Named)
	return ok && named.Obj().Pkg() != nil && named.Obj().Pkg().Path() == "testing" && (named.Obj().Name() == "T" || named.Obj().Name() == "F")
}

func runTestCaseStart(pass *analysis.Pass) (any, error) {
	if strings.TrimSuffix(pass.Pkg.Path(), "_test") == TestCasePackage {
		return nil, nil
	}
	for _, file := range pass.Files {
		if !strings.HasSuffix(pass.Fset.File(file.Pos()).Name(), "_test.go") {
			continue
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			name := ""
			if ok {
				name = function.Name.Name
			}
			if !ok || function.Recv != nil || function.Body == nil || !strings.HasPrefix(name, "Test") && !strings.HasPrefix(name, "Fuzz") || !testing(pass, function.Type.Params) {
				continue
			}
			started := false
			ast.Inspect(function.Body, func(node ast.Node) bool {
				if call, ok := node.(*ast.CallExpr); ok {
					called := callee(pass, call)
					for _, start := range []string{"Start", "Group", "Run", "Of"} {
						started = started || is(called, TestCasePackage, start)
					}
				}
				return !started
			})
			if !started {
				pass.Reportf(function.Name.Pos(), "%s does not start its case with packages/go/testcase, so it runs without a deadline or RUN line", name)
			}
		}
	}
	return nil, nil
}
