// Conformance checker: runs the client runners (or reads their outputs) and
// compares each vector's statements and result against tests/conformance/vectors.json
// with exact JSON number comparison and sorted object keys in diagnostics.
//
//	go run ./tests/conformance/check run -dsn … [-driver postgres|sqlite]  # run all four runners twice, then compare
//	go run ./tests/conformance/check run -driver mysql -dsn … -driver postgres -dsn … -driver sqlite -dsn …  # build once, check each database
//	go run ./tests/conformance/check compare [-driver …] out/…                                  # compare produced outputs (<lang>.json)
//	go run ./tests/conformance/check record [-driver …] out/{go,php,rust,typescript}.json       # record agreed expectations
//
// Expectations live in tests/conformance/vectors.json (MySQL) and
// tests/conformance/vectors.<driver>.json for the other databases: statements
// differ per dialect, results must not.
//
// `run` holds a directory lock per bench database (/tmp/orm-conformance-<DSN hash>.lock)
// while the runners use it; a second run on the same database fails instead of
// waiting, and runs on other databases do not conflict.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/polyspec/orm/internal/testcase"
)

// runner와 build 명령의 기한이다. build는 run 한 번에 한 번만 하고, 모든 database와 두 번의
// 실행이 build된 runner를 실행한다.
const (
	// rustBuildDeadline: orm-tests의 conformance binary를 debug로 build한다(test build와 의존성을
	// 함께 쓴다). target이 비었으면 의존성 전체를 compile한다(개발 machine에서 2-4분).
	rustBuildDeadline = 8 * time.Minute
	// typescriptBuildDeadline: TypeScript client를 tsc로 build한다(개발 machine에서 약 11 s).
	typescriptBuildDeadline = 2 * time.Minute
	// goBuildDeadline: Go runner를 binary로 build한다. build cache가 비었으면 driver와 engine
	// package를 compile한다(개발 machine에서 cache가 있으면 1 s 안, 비었으면 1분 안팎).
	goBuildDeadline = 3 * time.Minute
	// runnerDeadline: build된 runner process 하나가 bench database에서 모든 vector를 실행한다
	// (개발 machine에서 1-3 s). 1분이 지난 runner는 멈춘 것이다.
	runnerDeadline = time.Minute
	// stateDeadline: database state digest(state.go)나 counter(counters.go의 30 s)를 읽고
	// 되돌리는 일 하나의 기한이다. bench database의 digest는 1 s 안에 읽힌다.
	stateDeadline = time.Minute
	// languageDeadline: 한 언어의 case는 runner를 두 번 실행하고, 실행마다 state를 앞뒤로
	// 읽고 counter를 되돌린다(8분).
	languageDeadline = 2*runnerDeadline + 6*stateDeadline
	// compareDeadline: 네 output을 vector 기대값과 비교하는 memory 안의 계산이다.
	compareDeadline = testcase.Compute
)

type vec struct {
	Name   string          `json:"name"`
	Chain  string          `json:"chain"`
	Expect json.RawMessage `json:"expect"`
}

type file struct {
	Vectors []vec `json:"vectors"`
}

// driver selects the database: "mysql" (default) or postgres/sqlite. Every
// runner takes it as a driver flag, and the expectations file follows it.
var (
	driver string
	dsn    string
)

// listFlag는 여러 번 줄 수 있는 flag다. run은 -driver와 -dsn을 순서대로 짝짓는다.
type listFlag []string

func (l *listFlag) String() string { return strings.Join(*l, ",") }

func (l *listFlag) Set(value string) error {
	*l = append(*l, value)
	return nil
}

var requiredLanguages = []string{"go", "php", "rust", "typescript"}

func vectorsPath() string {
	if driver == "" || driver == "mysql" {
		return "tests/conformance/vectors.json"
	}
	return "tests/conformance/vectors." + driver + ".json"
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	var drivers, dsns listFlag
	fs.Var(&drivers, "driver", "mysql|postgres|sqlite (default mysql); run takes one -driver per -dsn")
	fs.Var(&dsns, "dsn", "bench database DSN URI for every runner (required by run and state)")
	fs.Parse(os.Args[2:])
	if len(drivers) == 0 {
		drivers = listFlag{"mysql"}
	}
	for _, name := range drivers {
		if name != "mysql" && name != "postgres" && name != "sqlite" {
			must(fmt.Errorf("unsupported database %q", name))
		}
	}
	if len(dsns) > len(drivers) || (len(drivers) > 1 && len(dsns) != len(drivers)) || (len(drivers) > 1 && os.Args[1] != "run") {
		usage()
	}
	driver = drivers[0]
	if len(dsns) > 0 {
		dsn = dsns[0]
	}
	root, err := os.Getwd()
	must(err)
	switch os.Args[1] {
	case "state":
		if dsn == "" {
			usage()
		}
		stateDB, err := openStateDatabase(driver, dsn)
		must(err)
		digest, err := snapshotDatabase(stateDB, driver)
		must(err)
		must(stateDB.Close())
		fmt.Printf("%s state %s\n", driver, digest)
	case "run":
		if len(dsns) != len(drivers) || slices.Contains(dsns, "") {
			usage()
		}
		must(lockDatabases(dsns...))
		binaries, err := os.MkdirTemp("", "orm-conformance-runners-")
		must(err)
		must(testcase.Run("conformance/build", rustBuildDeadline+typescriptBuildDeadline+goBuildDeadline, func(c *testcase.Case) error {
			return buildRunners(c, root, binaries)
		}))
		for index := range drivers {
			driver, dsn = drivers[index], dsns[index]
			runDatabase(root)
		}
		must(os.RemoveAll(binaries))
		must(releaseLocks())
	case "compare":
		os.Exit(compare(root, fs.Args()))
	case "record":
		must(recordVerified(root, fs.Args()))
	default:
		usage()
	}
}

// runDatabase는 driver와 dsn의 database에서 네 runner를 두 번씩 실행해 state를 확인하고,
// output을 vector 기대값과 비교한 뒤 검증된 output을 tests/conformance/out에 남긴다.
func runDatabase(root string) {
	out := filepath.Join(root, "tests", "conformance", "out", driverDir())
	must(os.MkdirAll(out, 0o755))
	must(removeVerifiedOutputs(out))
	pending, err := os.MkdirTemp(out, ".run-")
	must(err)
	stateDB, err := openStateDatabase(driver, dsn)
	must(err)
	for _, language := range requiredLanguages {
		first := filepath.Join(pending, language+".json")
		repeated := filepath.Join(pending, language+".repeat.json")
		must(testcase.Run("conformance/"+driver+"/"+language, languageDeadline, func(c *testcase.Case) error {
			return runLanguage(c, stateDB, root, language, first, repeated)
		}))
		must(os.Remove(repeated))
	}
	must(stateDB.Close())
	var files []string
	for _, l := range requiredLanguages {
		files = append(files, filepath.Join(pending, l+".json"))
	}
	must(testcase.Run("conformance/"+driver+"/compare", compareDeadline, func(*testcase.Case) error {
		if compare(root, files) != 0 {
			return fmt.Errorf("conformance comparison failed; output retained in %s", pending)
		}
		return nil
	}))
	for _, language := range requiredLanguages {
		must(os.Rename(filepath.Join(pending, language+".json"), filepath.Join(out, language+".json")))
	}
	must(os.Remove(pending))
	fmt.Printf("conformance: verified outputs saved in %s\n", out)
}

func runAndCheckState(db *sql.DB, database, language, phase string, run func() error) error {
	before, err := snapshotDatabase(db, database)
	if err != nil {
		return err
	}
	counters, err := readCounters(db, database)
	if err != nil {
		return err
	}
	runErr := run()
	restoreErr := restoreCounters(db, database, counters)
	after, snapshotErr := snapshotDatabase(db, database)
	var stateErr error
	if snapshotErr == nil && before != after {
		stateErr = fmt.Errorf("%s changed %s database state on %s run", language, database, phase)
	}
	return errors.Join(runErr, restoreErr, snapshotErr, stateErr)
}

// lockPath는 bench database 하나를 쓰는 동안 잡는 lock directory다. runner가 database에 쓰고
// 되돌리므로 같은 database를 쓰는 두 실행만 겹치면 안 된다. 이름은 DSN의 hash다.
func lockPath(dsn string) string {
	sum := sha256.Sum256([]byte(dsn))
	return "/tmp/orm-conformance-" + hex.EncodeToString(sum[:8]) + ".lock"
}

// held는 이 process가 잡은 lock directory다. must가 실패할 때 놓는다.
var held []string

// lockDatabases는 dsns의 database마다 lock을 잡는다. 이미 잡힌 lock이 있으면 기다리지 않고
// 실패한다.
func lockDatabases(dsns ...string) error {
	for _, value := range dsns {
		path := lockPath(value)
		if slices.Contains(held, path) {
			continue
		}
		if err := os.Mkdir(path, 0o755); err != nil {
			return fmt.Errorf("another conformance run holds %s: %w", path, err)
		}
		held = append(held, path)
	}
	return nil
}

func releaseLocks() error {
	var errs []error
	for _, path := range held {
		errs = append(errs, os.Remove(path))
	}
	held = nil
	return errors.Join(errs...)
}

func driverDir() string {
	if driver == "mysql" {
		return ""
	}
	return driver
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: check state -dsn x [-driver d] | check run [-driver d] -dsn x [-driver d -dsn x]... | check compare|record [-driver d] <go.json> <php.json> <rust.json> <typescript.json>")
	os.Exit(2)
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "check:", err)
		if cleanupErr := releaseLocks(); cleanupErr != nil {
			fmt.Fprintln(os.Stderr, "check: release conformance lock:", cleanupErr)
		}
		os.Exit(1)
	}
}

// runLanguage는 한 언어의 runner를 두 번 실행해 매번 database state가 그대로인지 확인하고
// 두 output이 같은지 비교한다.
func runLanguage(c *testcase.Case, stateDB *sql.DB, root, language, first, repeated string) error {
	c.Step("first run")
	if err := runAndCheckState(stateDB, driver, language, "first", func() error { return runOne(c, root, first, language) }); err != nil {
		return err
	}
	c.Step("repeated run")
	if err := runAndCheckState(stateDB, driver, language, "repeated", func() error { return runOne(c, root, repeated, language) }); err != nil {
		return err
	}
	c.Step("compare the two outputs")
	return compareRepeatedEvidence(first, repeated)
}

// goRunner는 buildRunners가 build한 Go runner binary다.
var goRunner string

// buildRunners는 Rust runner, TypeScript client와 Go runner를 한 번 build한다. Go runner는
// directory에 binary로 남는다.
func buildRunners(c *testcase.Case, root, directory string) error {
	if err := runCommand(c, root, "", rustBuildDeadline, "cargo", "build", "--locked", "--manifest-path", "clients/rust/Cargo.toml", "-p", "orm-tests", "--bin", "conformance"); err != nil {
		return err
	}
	if err := runCommand(c, root, "", typescriptBuildDeadline, "npm", "run", "build", "--prefix", "clients/typescript"); err != nil {
		return err
	}
	binary := filepath.Join(directory, "runner_go")
	if err := runCommand(c, root, "", goBuildDeadline, "go", "build", "-o", binary, "./tests/conformance/runner_go"); err != nil {
		return err
	}
	goRunner = binary
	return nil
}

func runOne(c *testcase.Case, root, output, language string) error {
	flags := []string{"--dsn", dsn}
	switch language {
	case "go":
		if goRunner == "" {
			return fmt.Errorf("go runner is not built")
		}
		return runCommand(c, root, output, runnerDeadline, goRunner, "-dsn", dsn)
	case "php":
		return runCommand(c, root, output, runnerDeadline, "php", append([]string{"tests/conformance/runner.php"}, flags...)...)
	case "typescript":
		return runCommand(c, root, output, runnerDeadline, "node", append([]string{"tests/conformance/runner_typescript.mjs"}, flags...)...)
	case "rust":
		target := os.Getenv("CARGO_TARGET_DIR")
		if target == "" {
			target = filepath.Join(root, "clients", "rust", "target")
		} else if !filepath.IsAbs(target) {
			target = filepath.Join(root, target)
		}
		return runCommand(c, root, output, runnerDeadline, filepath.Join(target, "debug", "conformance"), flags...)
	default:
		return fmt.Errorf("unsupported language %q", language)
	}
}

// runCommand는 명령 하나를 timeout과 case c의 기한 가운데 먼저 오는 것 안에 실행하고, 시작을
// c의 단계로 출력한다.
func runCommand(c *testcase.Case, root, output string, timeout time.Duration, name string, args ...string) error {
	ctx, cancel := context.WithTimeout(c.Context(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = root
	// 명령의 진행 출력(cargo의 Compiling 줄, runner의 log)은 경과 시간과 함께 case의 단계로 보인다.
	steps := c.StepWriter()
	cmd.Stderr = steps
	var buf bytes.Buffer
	if output == "" {
		cmd.Stdout = steps
	} else {
		cmd.Stdout = &buf
	}
	c.Step("run %s", displayCommand(cmd.Args))
	err := cmd.Run()
	steps.Flush()
	if ctx.Err() != nil {
		return fmt.Errorf("%s: %w", name, ctx.Err())
	}
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	if output != "" {
		return os.WriteFile(output, buf.Bytes(), 0o644)
	}
	return nil
}

func displayCommand(args []string) string {
	visible := append([]string(nil), args...)
	for i := 1; i < len(visible); i++ {
		if visible[i-1] == "--dsn" || visible[i-1] == "-dsn" {
			visible[i] = "<redacted>"
		}
	}
	return strings.Join(visible, " ")
}

func validateOutputFiles(outputs []string) error {
	if len(outputs) != len(requiredLanguages) {
		return fmt.Errorf("conformance requires %d language outputs, got %d", len(requiredLanguages), len(outputs))
	}
	want := map[string]bool{}
	for _, language := range requiredLanguages {
		want[language] = true
	}
	for _, output := range outputs {
		language := strings.TrimSuffix(filepath.Base(output), ".json")
		if filepath.Ext(output) != ".json" || !want[language] {
			return fmt.Errorf("duplicate or unknown language output %q", output)
		}
		delete(want, language)
	}
	return nil
}

func removeVerifiedOutputs(directory string) error {
	for _, language := range requiredLanguages {
		path := filepath.Join(directory, language+".json")
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func compareRepeatedEvidence(first, second string) error {
	a, err := os.ReadFile(first)
	if err != nil {
		return err
	}
	b, err := os.ReadFile(second)
	if err != nil {
		return err
	}
	equal, err := equalJSON(a, b)
	if err != nil {
		return err
	}
	if !equal {
		return fmt.Errorf("conformance output changed between runs: %s", first)
	}
	return nil
}

func decodeExact(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := readJSONValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("multiple JSON values")
		}
		return nil, err
	}
	return value, nil
}

func readJSONValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return token, nil
	}
	switch delimiter {
	case '{':
		object := map[string]any{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, fmt.Errorf("JSON object key is not text")
			}
			if _, exists := object[key]; exists {
				return nil, fmt.Errorf("duplicate JSON object key %q", key)
			}
			object[key], err = readJSONValue(decoder)
			if err != nil {
				return nil, err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if end != json.Delim('}') {
			return nil, fmt.Errorf("JSON object ended with %v", end)
		}
		return object, nil
	case '[':
		array := []any{}
		for decoder.More() {
			item, err := readJSONValue(decoder)
			if err != nil {
				return nil, err
			}
			array = append(array, item)
		}
		end, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if end != json.Delim(']') {
			return nil, fmt.Errorf("JSON array ended with %v", end)
		}
		return array, nil
	default:
		return nil, fmt.Errorf("unexpected JSON delimiter %q", delimiter)
	}
}

type exactNumber struct{ value string }

func normalizeExact(value any) (any, error) {
	switch typed := value.(type) {
	case json.Number:
		rational, ok := new(big.Rat).SetString(string(typed))
		if !ok {
			return nil, fmt.Errorf("invalid JSON number %q", typed)
		}
		return exactNumber{rational.RatString()}, nil
	case []any:
		result := make([]any, len(typed))
		for i, item := range typed {
			var err error
			result[i], err = normalizeExact(item)
			if err != nil {
				return nil, err
			}
		}
		return result, nil
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			var err error
			result[key], err = normalizeExact(item)
			if err != nil {
				return nil, err
			}
		}
		return result, nil
	default:
		return value, nil
	}
}

func equalJSON(a, b []byte) (bool, error) {
	left, err := decodeExact(a)
	if err != nil {
		return false, err
	}
	right, err := decodeExact(b)
	if err != nil {
		return false, err
	}
	left, err = normalizeExact(left)
	if err != nil {
		return false, err
	}
	right, err = normalizeExact(right)
	if err != nil {
		return false, err
	}
	return reflect.DeepEqual(left, right), nil
}

// load reads the vector list (names and chains) from vectors.json — the single
// place a vector is declared — and, for another database, overlays the
// expectations recorded for that dialect (vectors.<driver>.json).
func load(root string) (file, error) {
	basePath := filepath.Join(root, "tests/conformance/vectors.json")
	b, err := os.ReadFile(basePath)
	if err != nil {
		return file{}, err
	}
	if _, err := decodeExact(b); err != nil {
		return file{}, fmt.Errorf("%s: %w", basePath, err)
	}
	var f file
	if err := json.Unmarshal(b, &f); err != nil {
		return file{}, fmt.Errorf("%s: %w", basePath, err)
	}
	declared, err := vectorNames(f.Vectors, basePath)
	if err != nil {
		return file{}, err
	}
	if driver == "mysql" {
		return f, nil
	}
	dialectPath := filepath.Join(root, vectorsPath())
	b, err = os.ReadFile(dialectPath)
	if err != nil {
		return file{}, err
	}
	if _, err := decodeExact(b); err != nil {
		return file{}, fmt.Errorf("%s: %w", dialectPath, err)
	}
	var d file
	if err := json.Unmarshal(b, &d); err != nil {
		return file{}, fmt.Errorf("%s: %w", dialectPath, err)
	}
	recorded, err := vectorNames(d.Vectors, dialectPath)
	if err != nil {
		return file{}, err
	}
	for name := range recorded {
		if _, ok := declared[name]; !ok {
			return file{}, fmt.Errorf("%s: undeclared vector %s", dialectPath, name)
		}
	}
	for i := range f.Vectors {
		v, ok := recorded[f.Vectors[i].Name]
		if !ok {
			return file{}, fmt.Errorf("%s: missing vector %s", dialectPath, f.Vectors[i].Name)
		}
		f.Vectors[i].Expect = v.Expect
	}
	return f, nil
}

func vectorNames(vectors []vec, path string) (map[string]vec, error) {
	if len(vectors) == 0 {
		return nil, fmt.Errorf("%s: no vectors", path)
	}
	names := make(map[string]vec, len(vectors))
	for _, v := range vectors {
		if v.Name == "" {
			return nil, fmt.Errorf("%s: empty vector name", path)
		}
		if _, exists := names[v.Name]; exists {
			return nil, fmt.Errorf("%s: duplicate vector %s", path, v.Name)
		}
		names[v.Name] = v
	}
	return names, nil
}

// canon re-encodes JSON with sorted keys and without changing number precision.
func canon(raw json.RawMessage) string {
	v, err := decodeExact(raw)
	must(err)
	b, err := json.MarshalIndent(v, "", "  ")
	must(err)
	return string(b)
}

func compare(root string, outputs []string) int {
	if err := validateOutputFiles(outputs); err != nil {
		fmt.Fprintln(os.Stderr, "check:", err)
		return 1
	}
	f, err := load(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "check:", err)
		return 1
	}
	type got map[string]json.RawMessage
	langs := []string{}
	results := map[string]got{}
	for _, p := range outputs {
		lang := strings.TrimSuffix(filepath.Base(p), ".json")
		b, err := os.ReadFile(p)
		must(err)
		_, err = decodeExact(b)
		must(err)
		var g got
		must(json.Unmarshal(b, &g))
		langs = append(langs, lang)
		results[lang] = g
	}
	failed := 0
	declared := map[string]bool{}
	for _, v := range f.Vectors {
		declared[v.Name] = true
		if len(v.Expect) == 0 || string(v.Expect) == "null" {
			fmt.Printf("%-22s (no expectation recorded)\n", v.Name)
			failed++
			continue
		}
		want := canon(v.Expect)
		line := fmt.Sprintf("%-22s", v.Name)
		var diffs []string
		for _, lang := range langs {
			g, ok := results[lang][v.Name]
			if !ok {
				line += fmt.Sprintf(" %s:MISSING", lang)
				failed++
				continue
			}
			equal, err := equalJSON(g, v.Expect)
			must(err)
			if !equal {
				got := canon(g)
				line += fmt.Sprintf(" %s:DIFF", lang)
				failed++
				diffs = append(diffs, fmt.Sprintf("--- %s expected\n%s\n--- %s got\n%s\n", v.Name, want, lang, got))
			} else {
				line += fmt.Sprintf(" %s:ok", lang)
			}
		}
		fmt.Println(line)
		for _, d := range diffs {
			fmt.Print(d)
		}
	}
	for _, lang := range langs {
		for name := range results[lang] {
			if !declared[name] {
				fmt.Printf("%-22s %s:UNDECLARED\n", name, lang)
				failed++
			}
		}
	}
	if failed == 0 {
		fmt.Printf("conformance: %d vectors × %d languages identical\n", len(f.Vectors), len(langs))
		return 0
	}
	fmt.Printf("conformance: %d mismatches\n", failed)
	return 1
}

func recordVerified(root string, outputs []string) error {
	if err := validateOutputFiles(outputs); err != nil {
		return err
	}
	f, err := load(root)
	if err != nil {
		return err
	}
	results := make(map[string]map[string]json.RawMessage, len(outputs))
	for _, output := range outputs {
		b, err := os.ReadFile(output)
		if err != nil {
			return err
		}
		if _, err := decodeExact(b); err != nil {
			return fmt.Errorf("%s: %w", output, err)
		}
		var values map[string]json.RawMessage
		if err := json.Unmarshal(b, &values); err != nil {
			return fmt.Errorf("%s: %w", output, err)
		}
		results[strings.TrimSuffix(filepath.Base(output), ".json")] = values
	}
	goResults := results["go"]
	declared := make(map[string]bool, len(f.Vectors))
	for i := range f.Vectors {
		name := f.Vectors[i].Name
		declared[name] = true
		r, ok := goResults[name]
		if !ok {
			return fmt.Errorf("vector %s missing from go output", name)
		}
		for _, language := range requiredLanguages[1:] {
			other, ok := results[language][name]
			if !ok {
				return fmt.Errorf("vector %s missing from %s output", name, language)
			}
			equal, err := equalJSON(r, other)
			if err != nil {
				return fmt.Errorf("vector %s in %s output: %w", name, language, err)
			}
			if !equal {
				return fmt.Errorf("vector %s differs between go and %s outputs", name, language)
			}
		}
		f.Vectors[i].Expect = json.RawMessage(canon(r))
	}
	for _, language := range requiredLanguages {
		for name := range results[language] {
			if !declared[name] {
				return fmt.Errorf("%s output has undeclared vector %q", language, name)
			}
		}
	}
	out, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(root, vectorsPath())
	temporary, err := os.CreateTemp(filepath.Dir(path), ".vectors-")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if err := temporary.Chmod(0o644); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(out, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary.Name(), path); err != nil {
		return err
	}
	fmt.Printf("recorded %d agreed vectors into %s\n", len(f.Vectors), vectorsPath())
	return nil
}
