// Interface checks compare native declarations to a reviewed symbol manifest and
// enforce common method contracts independently of the generated source.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/polyspec/orm/contracts"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/schema"
)

type Symbols map[string]string
type Language struct {
	Roots   []string `json:"roots"`
	Symbols string   `json:"symbols"`
}
type Native struct {
	Symbol    string `json:"symbol"`
	Signature string `json:"signature"`
}
type Rule struct {
	ID     string            `json:"id"`
	For    string            `json:"for"`
	Inputs []string          `json:"inputs"`
	Output string            `json:"output"`
	Errors []string          `json:"errors"`
	State  string            `json:"state"`
	Native map[string]Native `json:"native"`
}
type Manifest struct {
	Version      int                 `json:"version"`
	Schema       string              `json:"schema"`
	Languages    map[string]Language `json:"languages"`
	SymbolHashes map[string]string   `json:"symbol_hashes"`
	Rules        []Rule              `json:"rules"`
	Components   []json.RawMessage   `json:"components"`
	Sequences    []Sequence          `json:"sequences"`
	Records      []Record            `json:"records"`
	Storage      []Rule              `json:"storage"`
	Owners       []Owner             `json:"owners"`
}
type Sequence struct {
	ID         string `json:"id"`
	Expected   any    `json:"expected"`
	Statements int    `json:"statements"`
}

func main() {
	root := flag.String("root", ".", "repository root")
	record := flag.Bool("record", false, "write candidate native symbol inventories after common-contract checks")
	selfTest := flag.Bool("self-test", false, "also verify native parsers reject source mutations")
	generate := flag.Bool("generate", false, "regenerate the component diagram from the manifest")
	results := flag.String("results", "", "also check state traces in this conformance output directory")
	flag.Parse()
	abs, err := filepath.Abs(*root)
	must(err)
	var m Manifest
	readJSON(filepath.Join(abs, "contracts/interfaces.json"), &m)
	if m.Version != 1 || len(m.Languages) != 4 || len(m.SymbolHashes) != 4 || len(m.Components) == 0 || len(m.Sequences) == 0 {
		fatal("invalid interface manifest")
	}
	diagram, err := contracts.Diagram()
	must(err)
	diagramPath := filepath.Join(abs, "docs/interfaces-model.md")
	koDiagram, err := contracts.DiagramKO()
	must(err)
	koDiagramPath := filepath.Join(abs, "docs/interfaces-model.ko.md")
	if *generate {
		must(os.WriteFile(diagramPath, diagram, 0644))
		must(os.WriteFile(koDiagramPath, koDiagram, 0644))
	} else {
		stored, err := os.ReadFile(diagramPath)
		must(err)
		if !bytes.Equal(stored, diagram) {
			fatal("component diagram differs from the manifest; run with --generate")
		}
		storedKo, err := os.ReadFile(koDiagramPath)
		must(err)
		if !bytes.Equal(storedKo, koDiagram) {
			fatal("Korean component diagram differs from the manifest; run with --generate")
		}
	}
	js, err := os.ReadFile(filepath.Join(abs, m.Schema))
	must(err)
	s, err := schema.Load(js)
	must(err)
	rust := buildRust(abs)
	failed := false
	for _, lang := range []string{"go", "php", "rust", "typescript"} {
		config := m.Languages[lang]
		actual, err := extract(abs, lang, config.Roots, rust, abs)
		must(err)
		errors := checkRules(lang, actual, m.Rules, s)
		errors = append(errors, checkRules(lang, actual, m.Storage, s)...)
		errors = append(errors, checkRecords(lang, actual, m.Records)...)
		errors = append(errors, checkOwners(lang, actual, m.Owners, s)...)
		if len(errors) > 0 {
			for _, e := range errors {
				fmt.Fprintln(os.Stderr, e)
			}
			failed = true
			continue
		}
		path := filepath.Join(abs, config.Symbols)
		if *record {
			writeJSON(path, actual)
		} else {
			var expected Symbols
			readJSON(path, &expected)
			diff := differences(expected, actual)
			if len(diff) > 0 {
				for _, d := range diff {
					fmt.Fprintf(os.Stderr, "%s: %s\n", lang, d)
				}
				failed = true
			}
		}
		if gotHash, err := fileSHA256(path); err != nil {
			must(err)
		} else if wantHash := m.SymbolHashes[lang]; wantHash != gotHash {
			fmt.Fprintf(os.Stderr, "%s: symbol snapshot hash differs from contracts/interfaces.json\n  want %s\n  got  %s\n", lang, wantHash, gotHash)
			failed = true
		}
		if *selfTest {
			must(parserMutations(abs, lang, rust))
			if lang == "php" {
				out, err := exec.Command("php", filepath.Join(abs, "tests/interfaces/wire.php"), abs).CombinedOutput()
				fmt.Print(string(out))
				must(err)
			}
		}
		fmt.Printf("%s: %d native symbols inspected; shared signatures and records checked\n", lang, len(actual))
	}
	if *results != "" {
		for _, lang := range []string{"go", "php", "rust", "typescript"} {
			var output map[string]struct {
				Result     any               `json:"result"`
				Statements []json.RawMessage `json:"statements"`
			}
			readJSON(filepath.Join(abs, *results, lang+".json"), &output)
			for _, s := range m.Sequences {
				got, ok := output[s.ID]
				if !ok || !reflect.DeepEqual(got.Result, s.Expected) || len(got.Statements) != s.Statements {
					fmt.Fprintf(os.Stderr, "%s: state contract %s failed\n", lang, s.ID)
					failed = true
				}
			}
		}
	}
	if failed {
		os.Exit(1)
	}
}

func fileSHA256(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func readJSON(path string, dst any) {
	b, err := os.ReadFile(path)
	must(err)
	must(decodeJSON(b, dst))
}
func decodeJSON(b []byte, dst any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	return d.Decode(dst)
}
func writeJSON(path string, value any) {
	b, err := json.MarshalIndent(value, "", "  ")
	must(err)
	must(os.WriteFile(path, append(b, '\n'), 0644))
}
func fatal(s string) { fmt.Fprintln(os.Stderr, s); os.Exit(1) }
func must(err error) {
	if err != nil {
		fatal(err.Error())
	}
}
func compact(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
}

func differences(want, got Symbols) []string {
	var out []string
	for k, w := range want {
		g, ok := got[k]
		if !ok {
			out = append(out, "missing "+k)
		} else if w != g {
			out = append(out, fmt.Sprintf("changed %s\n  want %s\n  got  %s", k, w, g))
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			out = append(out, "unexpected "+k)
		}
	}
	sort.Strings(out)
	return out
}

func buildRust(root string) string {
	manifest := filepath.Join(root, "tests/interfaces/rust/Cargo.toml")
	cmd := exec.Command("cargo", "build", "--quiet", "--locked", "--manifest-path", manifest)
	if out, err := cmd.CombinedOutput(); err != nil {
		fatal(string(out) + err.Error())
	}
	return filepath.Join(root, "tests/interfaces/rust/target/debug/orm-interface-symbols")
}

func extract(root, lang string, roots []string, rust, toolRoot string) (Symbols, error) {
	if lang == "go" {
		return goSymbols(root, roots)
	}
	var cmd *exec.Cmd
	if lang == "php" {
		cmd = exec.Command("php", append([]string{filepath.Join(toolRoot, "tests/interfaces/php.php"), root}, roots...)...)
	} else if lang == "typescript" {
		cmd = exec.Command("node", append([]string{filepath.Join(toolRoot, "tests/interfaces/typescript.mjs"), root}, roots...)...)
	} else {
		cmd = exec.Command(rust, append([]string{root}, roots...)...)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%s declarations: %w\n%s", lang, err, stderr.String())
	}
	var symbols Symbols
	err = json.Unmarshal(out, &symbols)
	return symbols, err
}

func goSymbols(root string, roots []string) (Symbols, error) {
	out := Symbols{}
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
					if v.Recv != nil {
						t := v.Recv.List[0].Type
						receiver = "receiver=" + print(t) + " "
						if ptr, ok := t.(*ast.StarExpr); ok {
							t = ptr.X
						}
						if gen, ok := t.(*ast.IndexExpr); ok {
							t = gen.X
						}
						key += print(t) + "."
					}
					out[key+v.Name.Name] = receiver + print(v.Type)
				case *ast.GenDecl:
					for _, spec := range v.Specs {
						if t, ok := spec.(*ast.TypeSpec); ok {
							out[rel+"::"+t.Name.Name] = "type " + print(t)
							if fields, ok := t.Type.(*ast.StructType); ok {
								wire := map[string]string{}
								for _, f := range fields.Fields.List {
									for _, name := range f.Names {
										out[rel+"::"+t.Name.Name+"#field."+name.Name] = print(f.Type)
									}
									if len(f.Names) == 0 {
										name := strings.TrimPrefix(print(f.Type), "*")
										name = name[strings.LastIndex(name, ".")+1:]
										out[rel+"::"+t.Name.Name+"#field."+name] = print(f.Type)
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
									out[rel+"::"+t.Name.Name+"#wire"] = string(raw)
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

func pascal(s string) string {
	var b strings.Builder
	for _, p := range strings.Split(s, "_") {
		if p != "" {
			b.WriteString(strings.ToUpper(p[:1]) + p[1:])
		}
	}
	return b.String()
}

func checkRules(lang string, actual Symbols, rules []Rule, m *schema.Manifest) []string {
	var errors []string
	for _, rule := range rules {
		n, ok := rule.Native[lang]
		if !ok {
			errors = append(errors, rule.ID+": missing "+lang+" mapping")
			continue
		}
		for _, name := range m.Order {
			ent := m.Entities[name]
			maps := []map[string]string{}
			base := map[string]string{"entity": name, "Entity": pascal(name)}
			if rule.For == "versioned_entity" {
				if ent.Timestamps != nil && ent.Timestamps.Updated != "" {
					maps = append(maps, base)
				}
			} else if rule.For == "entity" {
				maps = append(maps, base)
			} else if rule.For == "scoped_entity" {
				if ent.Scope != "" {
					maps = append(maps, map[string]string{"entity": name, "Entity": pascal(name), "type": columnType(ent.Column(ent.Scope), lang)})
				}
			} else if rule.For == "aes_entity" {
				if ent.Column("aes_key_version") != nil {
					maps = append(maps, base)
				}
			} else if rule.For == "eq_column" {
				for _, col := range ent.Columns {
					if !ir.OpAllowed(col, "eq") {
						continue
					}
					t := columnType(col, lang)
					column := pascal(col.Name)
					maps = append(maps, map[string]string{"entity": name, "Entity": pascal(name), "column": col.Name, "Column": column, "columnCamel": strings.ToLower(column[:1]) + column[1:], "type": t})
				}
			} else {
				errors = append(errors, rule.ID+": unknown expansion "+rule.For)
				break
			}
			for _, vars := range maps {
				fill := func(s string) string {
					for k, v := range vars {
						s = strings.ReplaceAll(s, "{"+k+"}", v)
					}
					return s
				}
				key, want := fill(n.Symbol), fill(n.Signature)
				got, exists := actual[key]
				if !exists || compact(got) != compact(want) {
					errors = append(errors, fmt.Sprintf("%s/%s: %s\n  want %s\n  got  %s", lang, rule.ID, key, want, got))
				}
			}
		}
	}
	return errors
}

func columnType(c *schema.Col, lang string) string {
	t := c.Type
	if lang == "go" {
		switch t {
		case "i32":
			return "int32"
		case "i64":
			return "int64"
		case "f64", "decimal":
			return "float64"
		case "bool":
			return "bool"
		case "date", "datetime":
			return "time.Time"
		default:
			return "string"
		}
	}
	if lang == "php" {
		switch t {
		case "i32", "i64":
			return "int"
		case "f64", "decimal":
			return "float"
		case "bool":
			return "bool"
		default:
			return "string"
		}
	}
	if lang == "typescript" {
		switch t {
		case "i32", "i64", "f64", "decimal":
			return "number"
		case "bool":
			return "boolean"
		case "date", "datetime":
			return "string | Date"
		case "point":
			return "Point"
		default:
			return "string"
		}
	}
	switch t {
	case "i32":
		return "i32"
	case "i64":
		return "i64"
	case "f64", "decimal":
		return "f64"
	case "bool":
		return "bool"
	case "date":
		return "chrono::NaiveDate"
	case "datetime":
		return "chrono::NaiveDateTime"
	default:
		return "impl Into<String>"
	}
}
