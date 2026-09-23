package ormgen

import (
	"errors"
	"fmt"
	"go/ast"
	"go/types"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"
)

// scanRounds limits the rounds of a scan.
var scanRounds = 64

// scan loads the consumer packages, generates the model methods their calls
// need, and repeats until the calls type-check against the models. A call is
// resolved when its receiver type is known; a chain of missing methods is
// therefore resolved one link per round. The packages read the files of the
// temporary directory at the output directory through an overlay.
func (g *goGen) scan(patterns []string) error {
	overlay, err := g.overlay()
	if err != nil {
		return err
	}
	dir, err := os.Getwd()
	if err != nil {
		return err
	}
	modelPath, err := g.modelPath(overlay)
	if err != nil {
		return err
	}
	// Files that the default build ignores are loaded with the build tags and
	// platform their constraints need, so a tagged test is scanned as well.
	configs := []scanConfig{{}}
	for round := 0; round < scanRounds; round++ {
		g.pending = false
		g.errors = nil
		visited := map[string]bool{}
		var pkgs []*packages.Package
		for i := 0; i < len(configs); i++ {
			loaded, err := packages.Load(&packages.Config{
				Mode:       packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports,
				Dir:        dir,
				Tests:      true,
				BuildFlags: configs[i].buildFlags(),
				Env:        configs[i].env(),
				Overlay:    overlay,
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
					// The generated files are the models themselves, not calls
					// of a consumer.
					if overlay[name] != nil {
						continue
					}
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
			return errors.New(strings.Join(g.errors, "\n"))
		}
		if !g.pending {
			return compileErrors(dir, pkgs, overlay)
		}
		if err := g.write(); err != nil {
			return err
		}
		if overlay, err = g.overlay(); err != nil {
			return err
		}
	}
	return fmt.Errorf("model calls did not converge in %d scan rounds", scanRounds)
}

// modelPath returns the import path of the output directory, which may exist
// only in the overlay.
func (g *goGen) modelPath(overlay map[string][]byte) (string, error) {
	dir := g.outDir
	if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
		dir = filepath.Dir(dir)
	} else if err != nil {
		return "", err
	}
	own, err := packages.Load(&packages.Config{Mode: packages.NeedName, Dir: dir, Overlay: overlay}, g.outDir)
	if err != nil {
		return "", err
	}
	if len(own) != 1 || own[0].PkgPath == "" {
		return "", fmt.Errorf("%s is not a package of a Go module", g.out)
	}
	return own[0].PkgPath, nil
}

// compileErrors returns the errors of the packages loaded by a converged scan.
// An error in a generated file is a generation failure, and an error of a
// package that could not be found, such as a scan pattern that names no
// directory, is a scan failure; the other errors are a ConsumerError.
// Positions are relative to dir.
func compileErrors(dir string, pkgs []*packages.Package, overlay map[string][]byte) error {
	var generated, load, consumer []string
	for _, p := range pkgs {
		for _, e := range p.Errors {
			file := errorFile(e.Pos)
			path := file
			if path != "" && !filepath.IsAbs(path) {
				path = filepath.Join(dir, path)
			}
			message := e.Msg
			if file != "" {
				message = e.Error()
				if rel, err := filepath.Rel(dir, path); err == nil && !strings.HasPrefix(rel, "..") {
					message = rel + e.Pos[len(file):] + ": " + e.Msg
				}
			}
			switch {
			case overlay[path] != nil:
				generated = append(generated, message)
			case p.Name == "":
				load = append(load, message)
			default:
				consumer = append(consumer, message)
			}
		}
	}
	if len(generated) > 0 {
		return fmt.Errorf("the generated models do not compile:\n%s", listErrors(generated))
	}
	if len(load) > 0 {
		return fmt.Errorf("the scanned packages cannot be loaded:\n%s", listErrors(load))
	}
	if len(consumer) > 0 {
		return &ConsumerError{Errors: consumer}
	}
	return nil
}

// errorFile returns the file of an error position of the form file:line:col.
func errorFile(pos string) string {
	file := pos
	for range 2 {
		i := strings.LastIndexByte(file, ':')
		if i < 0 {
			return file
		}
		if _, err := strconv.Atoi(file[i+1:]); err != nil {
			return file
		}
		file = file[:i]
	}
	return file
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

// modelOfExpr resolves a generated model receiver even when the consumer
// package has an unrelated type error. go/types marks expressions downstream
// of that error invalid, but a direct ORM chain that starts at a constructor of
// the model package still identifies the model. An expression of a resolved
// type is a model only when that type is one.
func (g *goGen) modelOfExpr(info *types.Info, e ast.Expr, modelPath string) *goModel {
	if t := info.TypeOf(e); known(t) {
		return g.modelOf(t, modelPath)
	}
	call, ok := e.(*ast.CallExpr)
	if !ok {
		return nil
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return nil
	}
	if gm := g.modelOfConstructor(info, sel, modelPath); gm != nil {
		return gm
	}
	gm := g.modelOfExpr(info, sel.X, modelPath)
	if gm == nil || !returnsModel(sel.Sel.Name) {
		return nil
	}
	return gm
}

// returnsModel reports whether a model method returns its own model, so that a
// chain continues on the result. Get methods return values, related models or
// query results, and the listed methods end a chain.
func returnsModel(name string) bool {
	switch name {
	case "Orm_", "MarshalJSON", "ToArray", "Create", "Creates", "Update", "Save", "Delete":
		return false
	}
	return !strings.HasPrefix(name, "Get")
}

// modelOfConstructor returns the model whose constructor the selector names in
// the model package.
func (g *goGen) modelOfConstructor(info *types.Info, sel *ast.SelectorExpr, modelPath string) *goModel {
	id, ok := sel.X.(*ast.Ident)
	if !ok {
		return nil
	}
	pkg, ok := info.Uses[id].(*types.PkgName)
	if !ok || pkg.Imported().Path() != modelPath {
		return nil
	}
	for _, gm := range g.models {
		if gm.ctor == sel.Sel.Name {
			return gm
		}
	}
	return nil
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
		if !known(info.TypeOf(sel.X)) && g.modelOfExpr(info, sel.X, modelPath) == nil {
			return true
		}
		gm := g.modelOfExpr(info, sel.X, modelPath)
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
		// Generated model methods are exported; an unexported name is a
		// method of the model package's own implementation.
		if !ast.IsExported(name) {
			return true
		}
		args := make([]argInfo, len(call.Args))
		for i, a := range call.Args {
			if !known(info.TypeOf(a)) && g.modelOfExpr(info, a, modelPath) == nil {
				return true
			}
			args[i] = argInfo{model: g.modelOfExpr(info, a, modelPath), columnFunc: isOrmFunc(info, a)}
		}
		if name == "Relation" || name == "Relations" || strings.HasPrefix(name, "Join") || strings.HasPrefix(name, "LeftJoin") {
			if len(call.Args) == 1 && args[0].model != nil {
				g.relationGetter(pos, gm, args[0].model, name == "Relations", aliasOf(info, f, call.Args[0]))
			}
		}
		// Fixed methods and methods generated in an earlier round are already
		// handled. A model receiver's remaining selector is a consumer method
		// request; relying on go/types Selections here loses unresolved methods
		// and leaves the consumer with a compile error.
		if gm.static[name] || gm.methods[name] != "" {
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
