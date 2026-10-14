package analyzers

import (
	"go/ast"
	"go/token"
	"go/types"

	"golang.org/x/tools/go/analysis"
)

// DeferredExit reports each call of os.Exit after a defer in the same function. os.Exit does not run the deferred calls
// of its goroutine, so the temporary directory a defer removes, the lock it releases and the connection it closes stay.
// main ends with os.Exit(run()) and run returns the exit code. A function of the package that calls os.Exit, or calls such
// a function (fail, check, usage and other helpers), counts as calling os.Exit. A call after the first defer of a function,
// inside a deferred closure too, is reported.
var DeferredExit = &analysis.Analyzer{
	Name: "deferredexit",
	Doc:  "reports a call of os.Exit, or of a function of the package that calls it, after a defer of the same function",
	Run:  runDeferredExit,
}

func runDeferredExit(pass *analysis.Pass) (any, error) {
	declarations := map[*types.Func]*ast.FuncDecl{}
	for _, file := range pass.Files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Body == nil {
				continue
			}
			if object, ok := pass.TypesInfo.Defs[function.Name].(*types.Func); ok {
				declarations[object] = function
			}
		}
	}
	calls := func(declaration *ast.FuncDecl, visit func(*ast.CallExpr, *types.Func)) {
		ast.Inspect(declaration.Body, func(node ast.Node) bool {
			if call, ok := node.(*ast.CallExpr); ok {
				visit(call, callee(pass, call))
			}
			return true
		})
	}
	// exiting holds the functions of the package that call os.Exit, directly or through another of them.
	exiting := map[*types.Func]bool{}
	for grew := true; grew; {
		grew = false
		for object, declaration := range declarations {
			if exiting[object] {
				continue
			}
			calls(declaration, func(_ *ast.CallExpr, called *types.Func) {
				if !exiting[object] && (is(called, "os", "Exit") || (called != object && exiting[called])) {
					exiting[object] = true
					grew = true
				}
			})
		}
	}
	for object, declaration := range declarations {
		deferred := token.NoPos
		ast.Inspect(declaration.Body, func(node ast.Node) bool {
			if statement, ok := node.(*ast.DeferStmt); ok && (deferred == token.NoPos || statement.Pos() < deferred) {
				deferred = statement.Pos()
			}
			return true
		})
		if deferred == token.NoPos {
			continue
		}
		calls(declaration, func(call *ast.CallExpr, called *types.Func) {
			switch {
			case call.Pos() < deferred:
			case is(called, "os", "Exit"):
				pass.Reportf(call.Pos(), "%s calls os.Exit after a defer, which then never runs; return the exit code to main and end it with os.Exit(run())", object.Name())
			case called != object && exiting[called]:
				pass.Reportf(call.Pos(), "%s calls %s, which calls os.Exit, after a defer, which then never runs; return the exit code to main and end it with os.Exit(run())", object.Name(), called.Name())
			}
		})
	}
	return nil, nil
}
