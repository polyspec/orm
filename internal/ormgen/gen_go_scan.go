package ormgen

import (
	"fmt"
	"go/ast"
	"go/types"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

// scan loads the consumer packages, generates the model methods their calls
// need, and repeats until the calls type-check against the models. A call is
// resolved when its receiver type is known; a chain of missing methods is
// therefore resolved one link per round.
func (g *goGen) scan(patterns []string) error {
	outDir, err := filepath.Abs(g.out)
	if err != nil {
		return err
	}
	own, err := packages.Load(&packages.Config{Mode: packages.NeedName, Dir: outDir}, ".")
	if err != nil {
		return err
	}
	if len(own) != 1 || own[0].PkgPath == "" {
		return fmt.Errorf("%s is not a package of a Go module", g.out)
	}
	modelPath := own[0].PkgPath
	// Files that the default build ignores are loaded with the build tags and
	// platform their constraints need, so a tagged test is scanned as well.
	configs := []scanConfig{{}}
	for round := 0; round < 64; round++ {
		g.pending = false
		g.errors = nil
		visited := map[string]bool{}
		var pkgs []*packages.Package
		for i := 0; i < len(configs); i++ {
			loaded, err := packages.Load(&packages.Config{
				Mode:       packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports,
				Tests:      true,
				BuildFlags: configs[i].buildFlags(),
				Env:        configs[i].env(),
			}, patterns...)
			if err != nil {
				return err
			}
			for _, p := range loaded {
				for _, f := range p.Syntax {
					name := p.Fset.File(f.Pos()).Name()
					if visited[name] {
						continue
					}
					visited[name] = true
					g.visit(p, f, modelPath)
				}
				if round == 0 {
					for _, ignored := range p.IgnoredFiles {
						if config, ok := configFor(ignored); ok && !slices.Contains(configs, config) {
							configs = append(configs, config)
						}
					}
				}
			}
			pkgs = append(pkgs, loaded...)
		}
		if len(g.errors) > 0 {
			sort.Strings(g.errors)
			g.errors = slices.Compact(g.errors)
			return fmt.Errorf("%s", strings.Join(g.errors, "\n"))
		}
		if !g.pending {
			if msg := typeErrors(pkgs); msg != "" {
				return fmt.Errorf("the scanned packages do not compile with the generated models:\n%s", msg)
			}
			return nil
		}
		if err := g.write(); err != nil {
			return err
		}
	}
	return fmt.Errorf("model calls did not converge")
}

func typeErrors(pkgs []*packages.Package) string {
	var out []string
	for _, p := range pkgs {
		for _, e := range p.Errors {
			out = append(out, e.Error())
		}
	}
	if len(out) > 20 {
		out = out[:20]
	}
	return strings.Join(out, "\n")
}

// modelOf returns the generated model of a type, if it is one.
func (g *goGen) modelOf(t types.Type, modelPath string) *goModel {
	if t == nil || modelPath == "" {
		return nil
	}
	ptr, ok := t.(*types.Pointer)
	if !ok {
		return nil
	}
	named, ok := ptr.Elem().(*types.Named)
	if !ok || named.Obj().Pkg() == nil || strings.TrimSuffix(named.Obj().Pkg().Path(), "_test") != modelPath {
		return nil
	}
	return g.byType[named.Obj().Name()]
}

// known reports a type the checker resolved.
func known(t types.Type) bool {
	if t == nil {
		return false
	}
	b, ok := t.(*types.Basic)
	return !ok || b.Kind() != types.Invalid
}

func isOrmFunc(info *types.Info, e ast.Expr) bool {
	call, ok := e.(*ast.CallExpr)
	if !ok {
		return false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	obj := info.Uses[sel.Sel]
	if obj == nil || obj.Pkg() == nil || obj.Pkg().Path() != "github.com/polyspec/orm/clients/go/orm" {
		return false
	}
	switch sel.Sel.Name {
	case "DayOfWeek", "Year", "Month", "Date", "Distance", "PointX", "PointY":
		return true
	}
	return false
}

// visit generates methods for the model calls of one file.
func (g *goGen) visit(p *packages.Package, f *ast.File, modelPath string) {
	info := p.TypesInfo
	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if !known(info.TypeOf(sel.X)) {
			return true
		}
		gm := g.modelOf(info.TypeOf(sel.X), modelPath)
		if gm == nil {
			return true
		}
		pos := p.Fset.Position(call.Pos()).String()
		if wd, err := os.Getwd(); err == nil {
			if rel, err := filepath.Rel(wd, pos); err == nil {
				pos = rel
			}
		}
		name := sel.Sel.Name
		args := make([]argInfo, len(call.Args))
		for i, a := range call.Args {
			if !known(info.TypeOf(a)) {
				return true
			}
			args[i] = argInfo{model: g.modelOf(info.TypeOf(a), modelPath), columnFunc: isOrmFunc(info, a)}
		}
		if name == "Relation" || name == "Relations" || strings.HasPrefix(name, "Join") || strings.HasPrefix(name, "LeftJoin") {
			if len(call.Args) == 1 && args[0].model != nil {
				g.relationGetter(pos, gm, args[0].model, name == "Relations", aliasOf(info, f, call.Args[0]))
			}
		}
		if info.Selections[sel] != nil || gm.static[name] || gm.methods[name] != "" {
			return true
		}
		g.method(pos, gm, name, args)
		return true
	})
}

// aliasOf finds the Alias<Name> call applied to a relation child: in the
// argument chain itself or on the variable passed as the argument.
func aliasOf(info *types.Info, f *ast.File, arg ast.Expr) string {
	if name := chainAlias(arg); name != "" {
		return name
	}
	id, ok := arg.(*ast.Ident)
	if !ok {
		return ""
	}
	obj := info.ObjectOf(id)
	if obj == nil {
		return ""
	}
	alias := ""
	ast.Inspect(f, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.CallExpr:
			if sel, ok := x.Fun.(*ast.SelectorExpr); ok {
				if base := rootIdent(sel.X); base != nil && info.ObjectOf(base) == obj && strings.HasPrefix(sel.Sel.Name, "Alias") {
					alias = strings.TrimPrefix(sel.Sel.Name, "Alias")
				}
			}
		case *ast.AssignStmt:
			for i, lhs := range x.Lhs {
				if l, ok := lhs.(*ast.Ident); ok && info.ObjectOf(l) == obj && i < len(x.Rhs) {
					if name := chainAlias(x.Rhs[i]); name != "" {
						alias = name
					}
				}
			}
		case *ast.ValueSpec:
			for i, l := range x.Names {
				if info.ObjectOf(l) == obj && i < len(x.Values) {
					if name := chainAlias(x.Values[i]); name != "" {
						alias = name
					}
				}
			}
		}
		return true
	})
	return alias
}

func chainAlias(e ast.Expr) string {
	for {
		call, ok := e.(*ast.CallExpr)
		if !ok {
			return ""
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return ""
		}
		if strings.HasPrefix(sel.Sel.Name, "Alias") && len(sel.Sel.Name) > 5 {
			return strings.TrimPrefix(sel.Sel.Name, "Alias")
		}
		e = sel.X
	}
}

func rootIdent(e ast.Expr) *ast.Ident {
	for {
		switch x := e.(type) {
		case *ast.Ident:
			return x
		case *ast.CallExpr:
			e = x.Fun
		case *ast.SelectorExpr:
			e = x.X
		default:
			return nil
		}
	}
}
