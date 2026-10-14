// Package analyzers holds the go/analysis analyzers of the repository's rules for Go source. go vet runs them through
// the vet tool tests/analyzers/orm-vet (make go-vet-check/orm), over every package of the modules of go.work with their
// tests, so each rule reads the syntax trees and the types of the Go compiler instead of the text of a file.
package analyzers

import (
	"go/ast"
	"go/types"

	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/types/typeutil"
)

// All is every analyzer of the vet tool, in the order it reports.
var All = []*analysis.Analyzer{DeferredExit, CallerPath, TestCaseStart, CargoLease, TimeFailure}

// callee is the function or method that call calls by name, or nil for a call of a function value.
func callee(pass *analysis.Pass, call *ast.CallExpr) *types.Func {
	function, _ := typeutil.Callee(pass.TypesInfo, call).(*types.Func)
	return function
}

// is reports whether function is the function name of the package path.
func is(function *types.Func, path, name string) bool {
	return function != nil && function.Pkg() != nil && function.Pkg().Path() == path && function.Name() == name
}
