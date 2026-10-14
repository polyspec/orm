package analyzers

import (
	"go/ast"
	"go/constant"
	"go/token"
	"regexp"
	"slices"
	"strings"

	"golang.org/x/tools/go/analysis"
)

// TimeFailure reports each Go test that fails on a measured time above a fixed bound. A test measures and reports its
// performance and never fails on it (AGENTS.md): a measurement above a bound is reported as a warning. It reports two
// forms in a test file or a package under a tests folder: an if whose condition compares a measured time above a bound
// (`>`, `>=`) and whose body fails (t.Fatal, t.Error and their f forms, panic, return fmt.Errorf), and a check, expect or
// assert call on a measured time below a bound (`<`, `<=`). A lower bound (a wait that lasted at least a bound), a
// comparison of two measurements and a comparison with zero check correctness and are not reported.
var TimeFailure = &analysis.Analyzer{
	Name: "timefailure",
	Doc:  "reports a test that fails on a measured time above a fixed bound",
	Run:  runTimeFailure,
}

// measuredNames are the names of a measured time: CPU time, wall-clock time, elapsed time and the time waited.
var measuredNames = []string{"cpu", "cpuMs", "wall", "wallMs", "elapsed", "took", "waited", "parseMs", "parseElapsed", "parse_time", "emitMs"}

// boundName is the name of a fixed bound: a constant in capitals, or a budget, limit or deadline.
var boundName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{2,}$|[Bb]udget|[Ll]imit|[Dd]eadline`)

// measured reports whether expression is a measured time: a name of measuredNames (a variable or a field) or time.Since.
func measured(pass *analysis.Pass, expression ast.Expr) bool {
	switch expression := ast.Unparen(expression).(type) {
	case *ast.Ident:
		return slices.Contains(measuredNames, expression.Name)
	case *ast.SelectorExpr:
		return slices.Contains(measuredNames, expression.Sel.Name)
	case *ast.CallExpr:
		return is(callee(pass, expression), "time", "Since")
	}
	return false
}

// bound reports whether expression is a fixed bound: a constant other than zero, or a name of boundName.
func bound(pass *analysis.Pass, expression ast.Expr) bool {
	if value := pass.TypesInfo.Types[expression].Value; value != nil {
		return constant.Sign(value) != 0
	}
	switch expression := ast.Unparen(expression).(type) {
	case *ast.Ident:
		return boundName.MatchString(expression.Name)
	case *ast.SelectorExpr:
		return boundName.MatchString(expression.Sel.Name)
	}
	return false
}

// compares reports whether condition holds a comparison of a measured time with a bound by one of the operators.
func compares(pass *analysis.Pass, condition ast.Expr, operators ...token.Token) bool {
	found := false
	ast.Inspect(condition, func(node ast.Node) bool {
		if binary, ok := node.(*ast.BinaryExpr); ok && slices.Contains(operators, binary.Op) && measured(pass, binary.X) && bound(pass, binary.Y) {
			found = true
		}
		return !found
	})
	return found
}

// fails reports whether body fails the test: a call of Fatal, Fatalf, Error or Errorf, panic, or a return of fmt.Errorf.
func fails(pass *analysis.Pass, body *ast.BlockStmt) bool {
	found := false
	ast.Inspect(body, func(node ast.Node) bool {
		switch node := node.(type) {
		case *ast.CallExpr:
			if selector, ok := node.Fun.(*ast.SelectorExpr); ok && slices.Contains([]string{"Fatal", "Fatalf", "Error", "Errorf"}, selector.Sel.Name) && !is(callee(pass, node), "fmt", "Errorf") {
				found = true
			}
			if identifier, ok := node.Fun.(*ast.Ident); ok && identifier.Name == "panic" {
				found = true
			}
		case *ast.ReturnStmt:
			for _, result := range node.Results {
				if call, ok := result.(*ast.CallExpr); ok && is(callee(pass, call), "fmt", "Errorf") {
					found = true
				}
			}
		}
		return !found
	})
	return found
}

func runTimeFailure(pass *analysis.Pass) (any, error) {
	inTests := slices.Contains(strings.Split(pass.Pkg.Path(), "/"), "tests")
	for _, file := range pass.Files {
		if !inTests && !strings.HasSuffix(pass.Fset.File(file.Pos()).Name(), "_test.go") {
			continue
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch node := node.(type) {
			case *ast.IfStmt:
				if compares(pass, node.Cond, token.GTR, token.GEQ) && fails(pass, node.Body) {
					pass.Reportf(node.Pos(), "fails a test on a measured time above a bound; report it with a warning instead (AGENTS.md)")
				}
			case *ast.CallExpr:
				if identifier, ok := node.Fun.(*ast.Ident); ok && slices.Contains([]string{"check", "expect", "assert"}, identifier.Name) {
					for _, argument := range node.Args {
						if compares(pass, argument, token.LSS, token.LEQ) {
							pass.Reportf(node.Pos(), "fails a test on a measured time above a bound; report it with a warning instead (AGENTS.md)")
						}
					}
				}
			}
			return true
		})
	}
	return nil, nil
}
