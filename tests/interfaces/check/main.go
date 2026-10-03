// Interface checks compare native declarations to a reviewed symbol manifest and
// enforce common method contracts independently of the generated source.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/polyspec/orm/contracts"
	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
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
	Version           int                 `json:"version"`
	Schema            string              `json:"schema"`
	Languages         map[string]Language `json:"languages"`
	SymbolHashes      map[string]string   `json:"symbol_hashes"`
	ProhibitedSymbols []string            `json:"prohibited_symbols"`
	Rules             []Rule              `json:"rules"`
	Components        []json.RawMessage   `json:"components"`
	Sequences         []Sequence          `json:"sequences"`
	Records           []Record            `json:"records"`
	Storage           []Rule              `json:"storage"`
	Owners            []Owner             `json:"owners"`
}
type Sequence struct {
	ID         string `json:"id"`
	Expected   any    `json:"expected"`
	Statements int    `json:"statements"`
}

// interface check의 case 기한이다.
const (
	// manifestDeadline: manifest, error catalog, component diagram, dbspec 문서를 읽고
	// 비교하는 memory 안의 계산이다.
	manifestDeadline = testcase.Compute
	// rustBuildDeadline: tests/interfaces/rust의 symbol 추출기를 build한다. target이 비면
	// 의존성까지 compile한다.
	rustBuildDeadline = testcase.Process
	// languageDeadline: 한 언어의 native 선언을 추출기 process로 읽고, --self-test면
	// source mutation마다 추출기를 다시 실행한다.
	languageDeadline = testcase.Process
	// resultsDeadline: conformance output file을 읽어 state trace를 비교한다.
	resultsDeadline = testcase.Compute
)

// failure는 fatal이 case를 끝내는 error다. testcase.Run이 panic을 FAIL 줄로 보고하고,
// case 밖에서는 main이 출력하고 끝낸다.
type failure string

func (f failure) Error() string { return string(f) }

func main() {
	defer func() {
		if recovered := recover(); recovered != nil {
			if f, ok := recovered.(failure); ok {
				fmt.Fprintln(os.Stderr, string(f))
				os.Exit(1)
			}
			panic(recovered)
		}
	}()
	root := flag.String("root", ".", "repository root")
	record := flag.Bool("record", false, "write candidate native symbol inventories after common-contract checks")
	selfTest := flag.Bool("self-test", false, "also verify native parsers reject source mutations")
	generate := flag.Bool("generate", false, "regenerate the component diagram from the manifest")
	results := flag.String("results", "", "also check state traces in this conformance output directory")
	language := flag.String("language", "", "check one language; empty checks all four")
	flag.Parse()
	languages := []string{"go", "php", "rust", "typescript"}
	if *language != "" {
		if !slices.Contains(languages, *language) {
			fatal("unsupported language " + *language)
		}
		languages = []string{*language}
		fmt.Printf("diagnostic scope: %s only; the full interface check requires all four languages\n", *language)
	}
	abs, err := filepath.Abs(*root)
	must(err)
	var m Manifest
	var s *runtimemodel.Model
	if err := testcase.Run("interfaces/manifest", manifestDeadline, func(*testcase.Case) error {
		readJSON(filepath.Join(abs, "contracts/interfaces.json"), &m)
		if m.Version != 1 || len(m.Languages) != 4 || len(m.SymbolHashes) != 4 || len(m.ProhibitedSymbols) == 0 || len(m.Components) == 0 || len(m.Sequences) == 0 {
			return errors.New("invalid interface manifest")
		}
		if err := validateProhibitions(m.ProhibitedSymbols); err != nil {
			return err
		}
		codes, err := readErrorCatalog(abs)
		if err != nil {
			return err
		}
		rules := append(append([]Rule{}, m.Rules...), m.Storage...)
		if failures := checkErrorLabels(codes, rules, m.Sequences); len(failures) != 0 {
			return errors.New(strings.Join(failures, "\n"))
		}
		diagram, err := contracts.Diagram()
		if err != nil {
			return err
		}
		diagramPath := filepath.Join(abs, "docs/interfaces-model.md")
		koDiagram, err := contracts.DiagramKO()
		if err != nil {
			return err
		}
		koDiagramPath := filepath.Join(abs, "docs/interfaces-model.ko.md")
		if *generate {
			if err := os.WriteFile(diagramPath, diagram, 0644); err != nil {
				return err
			}
			if err := os.WriteFile(koDiagramPath, koDiagram, 0644); err != nil {
				return err
			}
		} else {
			stored, err := os.ReadFile(diagramPath)
			if err != nil {
				return err
			}
			if !bytes.Equal(stored, diagram) {
				return errors.New("component diagram differs from the manifest; run with --generate")
			}
			storedKo, err := os.ReadFile(koDiagramPath)
			if err != nil {
				return err
			}
			if !bytes.Equal(storedKo, koDiagram) {
				return errors.New("Korean component diagram differs from the manifest; run with --generate")
			}
		}
		// entity 단위 rule은 contract가 가리키는 dbspec document의 entity 순서로 펼친다.
		s, err = runtimemodel.LoadFiles(filepath.Join(abs, m.Schema))
		return err
	}); err != nil {
		os.Exit(1)
	}
	rust := ""
	if slices.Contains(languages, "rust") {
		if err := testcase.Run("interfaces/rust-build", rustBuildDeadline, func(c *testcase.Case) (err error) {
			rust, err = buildRust(c.Context(), abs)
			return err
		}); err != nil {
			os.Exit(1)
		}
	}
	failed := false
	for _, lang := range languages {
		if err := testcase.Run("interfaces/"+lang, languageDeadline, func(c *testcase.Case) error {
			return checkLanguage(c, abs, lang, rust, m, s, *record, *selfTest)
		}); err != nil {
			failed = true
		}
	}
	if *results != "" {
		if err := testcase.Run("interfaces/results", resultsDeadline, func(*testcase.Case) error {
			var problems []string
			for _, lang := range languages {
				var output map[string]struct {
					Result     any               `json:"result"`
					Statements []json.RawMessage `json:"statements"`
				}
				readJSON(filepath.Join(abs, *results, lang+".json"), &output)
				for _, s := range m.Sequences {
					got, ok := output[s.ID]
					if !ok || !reflect.DeepEqual(got.Result, s.Expected) || len(got.Statements) != s.Statements {
						problems = append(problems, fmt.Sprintf("%s: state contract %s failed", lang, s.ID))
					}
				}
			}
			if len(problems) > 0 {
				return errors.New(strings.Join(problems, "\n"))
			}
			return nil
		}); err != nil {
			failed = true
		}
	}
	if failed {
		os.Exit(1)
	}
}

// checkLanguage는 한 언어의 native 선언을 공통 contract, 기록된 symbol snapshot과 그 hash에
// 비교하고, selfTest면 추출기가 source mutation을 놓치지 않는지 확인한다.
func checkLanguage(c *testcase.Case, abs, lang, rust string, m Manifest, s *runtimemodel.Model, record, selfTest bool) error {
	config := m.Languages[lang]
	callFailures, err := checkCallsInRoots(abs, lang, config.Roots)
	if err != nil {
		return err
	}
	c.Step("extracting native declarations")
	actual, err := extract(c.Context(), abs, lang, config.Roots, rust, abs)
	if err != nil {
		return err
	}
	problems := checkRules(lang, actual, m.Rules, s)
	problems = append(problems, checkRules(lang, actual, m.Storage, s)...)
	problems = append(problems, checkRecords(lang, actual, m.Records)...)
	problems = append(problems, checkOwners(lang, actual, m.Owners)...)
	problems = append(problems, checkProhibitedSymbols(lang, actual, m.ProhibitedSymbols)...)
	problems = append(problems, callFailures...)
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "\n"))
	}
	path := filepath.Join(abs, config.Symbols)
	if record {
		writeJSON(path, actual)
	} else {
		var expected Symbols
		readJSON(path, &expected)
		for _, d := range differences(expected, actual) {
			problems = append(problems, fmt.Sprintf("%s: %s", lang, d))
		}
	}
	gotHash, err := fileSHA256(path)
	if err != nil {
		return err
	}
	if wantHash := m.SymbolHashes[lang]; wantHash != gotHash {
		problems = append(problems, fmt.Sprintf("%s: symbol snapshot hash differs from contracts/interfaces.json\n  want %s\n  got  %s", lang, wantHash, gotHash))
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "\n"))
	}
	if selfTest {
		c.Step("source mutations")
		if err := parserMutations(c.Context(), abs, lang, rust); err != nil {
			return err
		}
	}
	fmt.Printf("%s: %d native symbols inspected; shared signatures and records checked\n", lang, len(actual))
	return nil
}

func checkProhibitedSymbols(lang string, actual Symbols, prohibited []string) []string {
	normalize := func(value string) string {
		return strings.Map(func(r rune) rune {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				return unicode.ToLower(r)
			}
			return -1
		}, value)
	}
	var errors []string
	for symbol, signature := range actual {
		value := normalize(symbol + " " + signature)
		for _, name := range prohibited {
			if strings.Contains(value, normalize(name)) {
				errors = append(errors, fmt.Sprintf("%s: prohibited symbol %s matches %s", lang, name, symbol))
			}
		}
	}
	sort.Strings(errors)
	return errors
}

func validateProhibitions(prohibited []string) error {
	seen := make(map[string]bool, len(prohibited))
	for _, name := range prohibited {
		if name == "" || seen[name] {
			return fmt.Errorf("duplicate or empty prohibited symbol %q", name)
		}
		seen[name] = true
	}
	if !seen["multi_statement"] {
		return fmt.Errorf("interface manifest must prohibit multi_statement")
	}
	return nil
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
func fatal(s string) { panic(failure(s)) }
func must(err error) {
	if err != nil {
		fatal(err.Error())
	}
}
func compact(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
	// rustfmt permits a trailing comma in a parameter list; it is syntax-only
	// and does not change the shared method signature.
	return strings.ReplaceAll(s, ",)", ")")
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

// buildRust는 Rust symbol 도구를 build하고 cargo가 보고한 실행 file을 돌려준다.
// target directory는 CARGO_TARGET_DIR이나 cargo 설정이 정하므로(Makefile은 모든
// cargo 명령에 clients/rust/target을 준다) 경로를 짐작하지 않고 cargo의
// compiler-artifact message에서 읽는다.
func buildRust(ctx context.Context, root string) (string, error) {
	manifest := filepath.Join(root, "tests/interfaces/rust/Cargo.toml")
	cmd := exec.CommandContext(ctx, "cargo", "build", "--quiet", "--locked", "--manifest-path", manifest, "--message-format", "json-render-diagnostics")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", errors.New(stderr.String() + err.Error())
	}
	executable := ""
	for _, line := range bytes.Split(out, []byte("\n")) {
		var message struct {
			Reason     string                `json:"reason"`
			Target     struct{ Name string } `json:"target"`
			Executable string                `json:"executable"`
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		if err := json.Unmarshal(line, &message); err != nil {
			return "", fmt.Errorf("cargo build message %q: %w", line, err)
		}
		if message.Reason == "compiler-artifact" && message.Target.Name == "orm-interface-symbols" && message.Executable != "" {
			executable = message.Executable
		}
	}
	if executable == "" {
		return "", errors.New("cargo build reported no orm-interface-symbols executable")
	}
	return executable, nil
}

func extract(ctx context.Context, root, lang string, roots []string, rust, toolRoot string) (Symbols, error) {
	if lang == "go" {
		return goSymbols(root, roots)
	}
	var cmd *exec.Cmd
	if lang == "php" {
		cmd = exec.CommandContext(ctx, "php", append([]string{filepath.Join(toolRoot, "tests/interfaces/php.php"), root}, roots...)...)
	} else if lang == "typescript" {
		cmd = exec.CommandContext(ctx, "node", append([]string{filepath.Join(toolRoot, "tests/interfaces/typescript.mjs"), root}, roots...)...)
	} else {
		cmd = exec.CommandContext(ctx, rust, append([]string{root}, roots...)...)
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

func checkRules(lang string, actual Symbols, rules []Rule, m *runtimemodel.Model) []string {
	var errors []string
	for _, rule := range rules {
		n, ok := rule.Native[lang]
		if !ok {
			errors = append(errors, rule.ID+": missing "+lang+" mapping")
			continue
		}
		var maps []map[string]string
		switch rule.For {
		case "once":
			maps = append(maps, map[string]string{})
		case "entity":
			for _, name := range m.Order {
				maps = append(maps, map[string]string{"entity": name, "Entity": pascal(name)})
			}
		default:
			errors = append(errors, rule.ID+": unknown expansion "+rule.For)
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
	return errors
}
