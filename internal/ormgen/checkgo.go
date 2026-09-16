// ormgen check --lang go: the fragments Go code passes to expr/selectExpr/raw
// are raw SQL the engine only sees at run time. This walks the sources and
// checks what can be checked statically: every backtick-quoted name must exist
// as a column somewhere in the manifest, and the `?` count must match the binds
// given at the call site (when they are not a spread).
//
// A line carrying (or preceded by) a comment with `ormgen:ignore` is skipped —
// for the tests that deliberately pass a bad fragment to see the engine reject it.
package ormgen

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

// fragArg names the argument holding the fragment for each generated method
// shape; -1 means "the last string literal argument".
var fragMethods = map[string]int{
	"Expr": 0, "OrderByExpr": 0, "Raw": 0, "SelectExpr": 1, "Having": -1,
}

func checkGo(m *schema.Manifest, dirs []string) int {
	columns := map[string][]string{} // column name -> entities that have it
	for _, name := range m.Order {
		for _, c := range m.Entities[name].Columns {
			columns[c.Name] = append(columns[c.Name], name)
		}
	}
	problems := 0
	files := 0
	for _, dir := range dirs {
		err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
				return nil
			}
			fset := token.NewFileSet()
			f, perr := parser.ParseFile(fset, path, nil, parser.ParseComments)
			if perr != nil {
				fmt.Printf("%s: %v\n", path, perr)
				problems++
				return nil
			}
			files++
			// a deliberate negative (a test that wants the engine's error) says so on the line or above it
			ignored := map[int]bool{}
			for _, g := range f.Comments {
				for _, c := range g.List {
					if strings.Contains(c.Text, "ormgen:ignore") {
						line := fset.Position(c.Pos()).Line
						ignored[line], ignored[line+1] = true, true
					}
				}
			}
			ast.Inspect(f, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				name := sel.Sel.Name
				idx, known := fragMethods[name]
				if !known && !strings.HasSuffix(name, "Expr") {
					return true
				}
				if !known {
					idx = 0 // Set<Col>Expr(frag, binds...)
				}
				frag, at, ok := stringArg(call, idx)
				if !ok {
					return true
				}
				pos := fset.Position(at)
				if ignored[pos.Line] {
					return true
				}
				for _, col := range fragColumns(frag) {
					if columns[col] == nil {
						fmt.Printf("%s:%d: %s: no column named `%s` in the schema\n", pos.Filename, pos.Line, name, col)
						problems++
					}
				}
				// binds: the arguments after the fragment, unless the call spreads a slice
				if call.Ellipsis == token.NoPos {
					want := strings.Count(frag, "?")
					got := len(call.Args) - (idx + 1)
					if name == "SelectExpr" {
						got = 0
					}
					if got >= 0 && want != got {
						fmt.Printf("%s:%d: %s: fragment has %d placeholders but %d binds\n", pos.Filename, pos.Line, name, want, got)
						problems++
					}
				}
				return true
			})
			return nil
		})
		if err != nil {
			fail(err)
		}
	}
	fmt.Printf("\normgen check (go): %d files, %d problems\n", files, problems)
	if problems == 0 {
		// name the ambiguous columns so a reader knows what the static pass cannot decide
		var ambiguous []string
		for col, ents := range columns {
			if len(ents) > 1 {
				sort.Strings(ents)
				ambiguous = append(ambiguous, fmt.Sprintf("%s (%s)", col, strings.Join(ents, ", ")))
			}
		}
		sort.Strings(ambiguous)
		if len(ambiguous) > 0 {
			fmt.Printf("note: %d column names exist in more than one entity, so this pass only proves they exist somewhere; the engine checks them against the statement's entity at compile time: %s\n",
				len(ambiguous), strings.Join(ambiguous, "; "))
		}
	}
	if problems > 0 {
		return 1
	}
	return 0
}

// stringArg returns the i-th argument's string value (-1 = the last string literal).
func stringArg(call *ast.CallExpr, i int) (string, token.Pos, bool) {
	if i < 0 {
		for j := len(call.Args) - 1; j >= 0; j-- {
			if lit, ok := call.Args[j].(*ast.BasicLit); ok && lit.Kind == token.STRING {
				v, err := strconv.Unquote(lit.Value)
				return v, lit.Pos(), err == nil
			}
		}
		return "", 0, false
	}
	if i >= len(call.Args) {
		return "", 0, false
	}
	lit, ok := call.Args[i].(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return "", 0, false // a variable: only the engine can check it
	}
	v, err := strconv.Unquote(lit.Value)
	return v, lit.Pos(), err == nil
}

// fragColumns lists the `quoted` identifiers of a fragment (the engine resolves
// the same ones against the statement's entity).
func fragColumns(frag string) []string {
	var out []string
	for {
		i := strings.IndexByte(frag, '`')
		if i < 0 {
			return out
		}
		j := strings.IndexByte(frag[i+1:], '`')
		if j < 0 {
			return out
		}
		out = append(out, frag[i+1:i+1+j])
		frag = frag[i+j+2:]
	}
}
