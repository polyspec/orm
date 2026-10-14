package analyzers

import (
	"go/ast"
	"go/constant"
	"strings"

	"golang.org/x/tools/go/analysis"
)

// CargoLease reports each Go file that runs cargo build, test, check or clippy (the words "cargo" and the subcommand next
// to each other in an argument list or a string list) without the lease of the shared Rust target directory
// ("exclusive", "--wait") and a copy of its program (scripts/cargo-build-copy.mts): another checkout that shares the
// directory can rebuild the program between the build and the run.
var CargoLease = &analysis.Analyzer{
	Name: "cargolease",
	Doc:  "reports a Go file that runs cargo without the lease of the shared Rust target directory and a copy of its program",
	Run:  runCargoLease,
}

// stringValues returns the constant string value of each expression of a list, and "" for one that is no constant string.
func stringValues(pass *analysis.Pass, list []ast.Expr) []string {
	values := make([]string, len(list))
	for index, expression := range list {
		if value := pass.TypesInfo.Types[expression].Value; value != nil && value.Kind() == constant.String {
			values[index] = constant.StringVal(value)
		}
	}
	return values
}

func runCargoLease(pass *analysis.Pass) (any, error) {
	for _, file := range pass.Files {
		var cargo ast.Expr
		leased, copied := false, false
		ast.Inspect(file, func(node ast.Node) bool {
			var list []ast.Expr
			switch node := node.(type) {
			case *ast.CallExpr:
				list = node.Args
			case *ast.CompositeLit:
				list = node.Elts
			case *ast.BasicLit:
				copied = copied || strings.Contains(node.Value, "cargo-build-copy.mts")
			}
			values := stringValues(pass, list)
			for index := 0; index+1 < len(values); index++ {
				switch next := values[index+1]; {
				case values[index] == "cargo" && (next == "build" || next == "test" || next == "check" || next == "clippy"):
					if cargo == nil {
						cargo = list[index]
					}
				case values[index] == "exclusive" && next == "--wait":
					leased = true
				}
			}
			return true
		})
		if cargo != nil && (!leased || !copied) {
			pass.Reportf(cargo.Pos(), "runs cargo without the lease of the shared Rust target directory and a copy of its program; run it through lease run and scripts/cargo-build-copy.mts")
		}
	}
	return nil, nil
}
