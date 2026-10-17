package dbspec

import (
	"go/ast"
	goparser "go/parser"
	gotoken "go/token"
	"os"
	"strconv"
	"strings"
	"testing"
)

// TestSubtestNamesAreFlat checks that no case name of this package's tests
// contains "/". The name given to t.Run, and the name runTimed reports, must be
// the case id alone: a "/" makes go test report the case under a group path.
// The check reads the string literals of each name expression in the test
// files, so a name built from a case field is checked by its literal parts
// only.
func TestSubtestNamesAreFlat(t *testing.T) {
	files, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	fset := gotoken.NewFileSet()
	var offenders []string
	for _, entry := range files {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := goparser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			var nameArg ast.Expr
			switch fun := call.Fun.(type) {
			case *ast.SelectorExpr:
				if receiver, ok := fun.X.(*ast.Ident); ok && receiver.Name == "t" && fun.Sel.Name == "Run" {
					nameArg = call.Args[0]
				}
			case *ast.Ident:
				if fun.Name == "runTimed" && len(call.Args) >= 2 {
					nameArg = call.Args[1]
				}
			}
			if nameArg == nil {
				return true
			}
			ast.Inspect(nameArg, func(m ast.Node) bool {
				lit, ok := m.(*ast.BasicLit)
				if !ok || lit.Kind != gotoken.STRING {
					return true
				}
				value, err := strconv.Unquote(lit.Value)
				if err == nil && strings.Contains(value, "/") {
					offenders = append(offenders, fset.Position(lit.Pos()).String()+" "+strconv.Quote(value))
				}
				return true
			})
			return true
		})
	}
	if len(offenders) > 0 {
		t.Fatalf("%d case names contain \"/\":\n%s", len(offenders), strings.Join(offenders, "\n"))
	}
}
