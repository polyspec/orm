// Go symbol extractor of tests/interfaces/check: prints the declarations of the Go files under the given roots as one
// JSON object of symbol to signature, read from Go's own syntax trees (go/parser, go/printer) without executing code.
//
// A symbol is exported when its name is exported and, for a method or a field, so is its receiver or struct type.
//
// Usage: go run ./packages/go/internal/symbols <root> <directory>...
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: go run ./packages/go/internal/symbols <root> <directory>...")
		os.Exit(2)
	}
	symbols, err := goSymbols(os.Args[1], os.Args[2:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	out, err := json.Marshal(symbols)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(append(out, '\n')); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// symbol is one declaration: its signature and whether Go exports it.
type symbol struct {
	Signature string `json:"signature"`
	Exported  bool   `json:"exported"`
}

func goSymbols(root string, roots []string) (map[string]symbol, error) {
	out := map[string]symbol{}
	for _, dir := range roots {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, path, nil, 0)
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(root, path)
			print := func(node any) string {
				var b bytes.Buffer
				_ = printer.Fprint(&b, fset, node)
				return strings.Join(strings.Fields(b.String()), " ")
			}
			for _, decl := range f.Decls {
				switch v := decl.(type) {
				case *ast.FuncDecl:
					key, receiver := rel+"::", ""
					exported := ast.IsExported(v.Name.Name)
					if v.Recv != nil {
						t := v.Recv.List[0].Type
						receiver = "receiver=" + print(t) + " "
						if ptr, ok := t.(*ast.StarExpr); ok {
							t = ptr.X
						}
						if gen, ok := t.(*ast.IndexExpr); ok {
							t = gen.X
						}
						if id, ok := t.(*ast.Ident); ok {
							exported = exported && ast.IsExported(id.Name)
						}
						key += print(t) + "."
					}
					out[key+v.Name.Name] = symbol{receiver + print(v.Type), exported}
				case *ast.GenDecl:
					for _, spec := range v.Specs {
						if t, ok := spec.(*ast.TypeSpec); ok {
							typeExported := ast.IsExported(t.Name.Name)
							out[rel+"::"+t.Name.Name] = symbol{"type " + print(t), typeExported}
							if fields, ok := t.Type.(*ast.StructType); ok {
								wire := map[string]string{}
								for _, f := range fields.Fields.List {
									for _, name := range f.Names {
										out[rel+"::"+t.Name.Name+"#field."+name.Name] = symbol{print(f.Type), typeExported && ast.IsExported(name.Name)}
									}
									if len(f.Names) == 0 {
										name := strings.TrimPrefix(print(f.Type), "*")
										name = name[strings.LastIndex(name, ".")+1:]
										out[rel+"::"+t.Name.Name+"#field."+name] = symbol{print(f.Type), typeExported && ast.IsExported(name)}
										wire["@flatten"] = goWireType(f.Type)
										continue
									}
									if f.Tag == nil {
										continue
									}
									tag, err := strconv.Unquote(f.Tag.Value)
									if err != nil {
										return err
									}
									name := strings.Split(reflect.StructTag(tag).Get("json"), ",")[0]
									if name != "" && name != "-" {
										wire[name] = goWireType(f.Type)
									}
								}
								if len(wire) > 0 {
									raw, _ := json.Marshal(wire)
									out[rel+"::"+t.Name.Name+"#wire"] = symbol{string(raw), typeExported}
								}
							}
						}
					}
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// goWireType is the common wire type of a Go field type: a pointer is its element, a slice a list, a map with a text key
// a map, and the basic types text, bool and integer; any other name is a record name.
func goWireType(t ast.Expr) string {
	switch n := t.(type) {
	case *ast.StarExpr:
		return goWireType(n.X)
	case *ast.ArrayType:
		return "list<" + goWireType(n.Elt) + ">"
	case *ast.MapType:
		if goWireType(n.Key) != "text" {
			return "invalid-map-key"
		}
		return "map<" + goWireType(n.Value) + ">"
	case *ast.Ident:
		switch n.Name {
		case "string":
			return "text"
		case "bool":
			return "bool"
		case "int", "int32", "int64", "uint32", "uint64", "uint":
			return "integer"
		default:
			return n.Name
		}
	}
	return fmt.Sprintf("unsupported-%T", t)
}
