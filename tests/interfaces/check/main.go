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
	"github.com/polyspec/orm/internal/stmtdiff"
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

// Sequence는 공통 state contract 하나다. Statements는 그 sequence가 보내는 statement의 kind를 순서대로 적는다:
// model statement(select, insert, update, delete), transaction 제어(begin, commit, rollback, savepoint, release,
// rollback_to)와 schema statement. utility statement(named lock, transaction-local 값 등)는 적지 않는다: 그
// 수와 위치는 dialect마다 다르고(MySQL의 GET_LOCK과 RELEASE_LOCK), 정확한 목록은 conformance vector
// (tests/conformance/vectors*.json)가 dialect마다 정해 make conformance-check가 비교한다.
type Sequence struct {
	ID         string   `json:"id"`
	Expected   any      `json:"expected"`
	Statements []string `json:"statements"`
}

// sequenceOutput은 conformance 출력의 vector 하나다. 각 statement는 statement event의 kind를 가진다
// (docs/usage.md "Statement events").
type sequenceOutput struct {
	Result     any `json:"result"`
	Statements []struct {
		Kind *string `json:"kind"`
		SQL  string  `json:"sql"`
	} `json:"statements"`
}

// statementKinds는 statement event의 모든 kind다.
var statementKinds = map[string]bool{
	"select": true, "insert": true, "update": true, "delete": true,
	"begin": true, "commit": true, "rollback": true, "savepoint": true, "release": true, "rollback_to": true,
	"schema": true, "utility": true,
}

// checkSequences는 한 언어의 conformance 출력(file)을 공통 state contract와 비교해 차이마다 그 이유를 적는다:
// 없는 vector, 다른 result(두 값), kind가 없거나 알 수 없는 statement, 그리고 contract의 statement kind
// 목록과 다른 statement(더해지거나 빠진 statement를 위치, kind, SQL과 함께).
func checkSequences(file string, output map[string]sequenceOutput, sequences []Sequence) []string {
	var problems []string
	for _, s := range sequences {
		prefix := fmt.Sprintf("%s: state contract %s", file, s.ID)
		got, ok := output[s.ID]
		if !ok {
			problems = append(problems, fmt.Sprintf("%s: the output has no %s vector", prefix, s.ID))
			continue
		}
		if !reflect.DeepEqual(got.Result, s.Expected) {
			problems = append(problems, fmt.Sprintf("%s: result %s, expected %s", prefix, jsonText(got.Result), jsonText(s.Expected)))
		}
		var actual []stmtdiff.Statement
		for index, statement := range got.Statements {
			switch {
			case statement.Kind == nil:
				problems = append(problems, fmt.Sprintf("%s: statement #%d (%s) has no kind", prefix, index+1, statement.SQL))
			case !statementKinds[*statement.Kind]:
				problems = append(problems, fmt.Sprintf("%s: statement #%d (%s) has the unknown kind %q", prefix, index+1, statement.SQL, *statement.Kind))
			case *statement.Kind != "utility":
				actual = append(actual, stmtdiff.Statement{Kind: *statement.Kind, Text: statement.SQL, Key: *statement.Kind})
			}
		}
		expected := make([]stmtdiff.Statement, len(s.Statements))
		for index, kind := range s.Statements {
			expected[index] = stmtdiff.Statement{Kind: kind, Key: kind}
		}
		if changes := stmtdiff.Diff(expected, actual); len(changes) > 0 {
			lines := []string{fmt.Sprintf("%s: statements other than utility differ from the contract: %s", prefix, stmtdiff.Summary(changes, stmtdiff.Group))}
			for _, change := range changes {
				lines = append(lines, "  "+change.String())
			}
			problems = append(problems, strings.Join(lines, "\n"))
		}
	}
	return problems
}

// resultDirectories는 반복할 수 있는 --results다.
type resultDirectories []string

func (r *resultDirectories) String() string { return strings.Join(*r, ",") }

func (r *resultDirectories) Set(value string) error {
	*r = append(*r, value)
	return nil
}

// jsonText는 값을 한 줄 JSON으로 적는다.
func jsonText(value any) string {
	b, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(b)
}

// checkResults는 conformance 실행의 output directory 하나(MySQL은 그 root, PostgreSQL과 SQLite는 그 안의
// directory)의 네 언어 output을 공통 state contract와 비교한다. output file이 없으면 그 정확한 경로를 적는다.
func checkResults(directory string, languages []string, sequences []Sequence) []string {
	var problems []string
	for _, lang := range languages {
		path := filepath.Join(directory, lang+".json")
		b, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			problems = append(problems, fmt.Sprintf("missing input %s: the conformance run of this check did not write the %s output", path, lang))
			continue
		}
		if err != nil {
			problems = append(problems, fmt.Sprintf("read %s: %v", path, err))
			continue
		}
		var output map[string]sequenceOutput
		if err := decodeJSON(b, &output); err != nil {
			problems = append(problems, fmt.Sprintf("%s is not a conformance output: %v", path, err))
			continue
		}
		problems = append(problems, checkSequences(path, output, sequences)...)
	}
	return problems
}

// interface check의 case 기한이다.
const (
	// manifestDeadline: manifest, error catalog, component diagram, dbspec 문서를 읽고
	// 비교하는 memory 안의 계산이다.
	manifestDeadline = testcase.Compute
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
	var results resultDirectories
	flag.Var(&results, "results", "also check the state traces of a conformance output directory of this run, repeatable")
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
		// 추출기는 lease 아래에서 이 실행의 directory로 복사한 것을 실행한다. directory는 process가 끝날 때 지운다.
		directory, err := os.MkdirTemp("", "orm-interface-symbols-")
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		defer os.RemoveAll(directory)
		if err := testcase.RunLong("interfaces/rust-build", func(c *testcase.Case) (err error) {
			rust, err = buildRust(c, abs, directory)
			return err
		}); err != nil {
			os.RemoveAll(directory)
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
	if len(results) > 0 {
		if err := testcase.Run("interfaces/results", resultsDeadline, func(*testcase.Case) error {
			var problems []string
			for _, directory := range results {
				problems = append(problems, checkResults(directory, languages, m.Sequences)...)
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

// buildRust는 Rust symbol 도구를 공유 Rust target directory의 exclusive lease(LEASE, CARGO_LEASES, --wait)
// 아래에서 build하고, 그 lease 안에서 directory로 복사한 실행 file을 돌려준다(scripts/cargo-build-copy.sh).
// 다른 checkout의 build가 target directory를 바꿔도 이 실행의 추출기는 바뀌지 않는다. build는 장기 작업이므로
// 기한이 없고, cargo의 진행 출력은 경과 시간과 함께 c의 단계로 보인다.
func buildRust(c *testcase.Case, root, directory string) (string, error) {
	lease, leases := os.Getenv("LEASE"), os.Getenv("CARGO_LEASES")
	if lease == "" || leases == "" {
		return "", errors.New("LEASE and CARGO_LEASES are unset; run this through make, which exports them")
	}
	manifest := filepath.Join(root, "tests/interfaces/rust/Cargo.toml")
	cmd := exec.CommandContext(c.Context(), lease, "run", leases, "exclusive", "--wait", "--", "sh", filepath.Join(root, "scripts", "cargo-build-copy.sh"),
		directory, "debug/orm-interface-symbols", "--", "cargo", "build", "--locked", "--manifest-path", manifest)
	steps := c.StepWriter()
	cmd.Stdout = steps
	cmd.Stderr = steps
	c.Step("run cargo build --locked --manifest-path %s under the target lease", manifest)
	err := cmd.Run()
	steps.Flush()
	if err != nil {
		return "", fmt.Errorf("cargo build: %w", err)
	}
	executable := filepath.Join(directory, "debug", "orm-interface-symbols")
	if info, err := os.Stat(executable); err != nil || info.IsDir() {
		return "", fmt.Errorf("cargo build left no executable %s: %v", executable, err)
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
