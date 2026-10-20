package analyzers

import (
	"go/ast"
	"go/types"

	"golang.org/x/tools/go/analysis"
)

// CallerPath reports each use of runtime.Caller and runtime.Callers. runtime.Caller gives the path a binary was compiled
// at, not the checkout that runs it: a -trimpath build gives the module path, and a binary built in another folder gives
// that folder. go test runs a test in its package folder, so a test finds its files from the working directory (os.Getwd).
var CallerPath = &analysis.Analyzer{
	Name: "callerpath",
	Doc:  "reports a use of runtime.Caller or runtime.Callers to find a source file",
	Run:  runCallerPath,
}

func runCallerPath(pass *analysis.Pass) (any, error) {
	for _, file := range pass.Files {
		ast.Inspect(file, func(node ast.Node) bool {
			identifier, ok := node.(*ast.Ident)
			if !ok {
				return true
			}
			function, ok := pass.TypesInfo.Uses[identifier].(*types.Func)
			if !ok {
				return true
			}
			if is(function, "runtime", "Caller") || is(function, "runtime", "Callers") {
				pass.Reportf(identifier.Pos(), "runtime.%s gives the path the binary was compiled at, not the checkout that runs it; find files from the working directory (os.Getwd), which go test sets to the package directory", function.Name())
			}
			return true
		})
	}
	return nil, nil
}
