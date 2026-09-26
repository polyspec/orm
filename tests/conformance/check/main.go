// Conformance checker: runs the client runners (or reads their outputs) and
// compares each vector's statements and result against tests/conformance/vectors.json
// with exact JSON number comparison and sorted object keys in diagnostics.
//
//	go run ./tests/conformance/check run -dsn … [-driver postgres|sqlite]  # run all four runners twice, then compare
//	go run ./tests/conformance/check compare [-driver …] out/…                                  # compare produced outputs (<lang>.json)
//	go run ./tests/conformance/check record [-driver …] out/go.json                             # fill expectations from one output
//
// Expectations live in tests/conformance/vectors.json (MySQL) and
// tests/conformance/vectors.<driver>.json for the other databases: statements
// differ per dialect, results must not.
//
// `run` holds the directory lock /tmp/orm-conformance.lock while the runners
// use the shared bench database; a second run fails instead of waiting.
package main

import (
	"bytes"
	"context"
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
	"strings"
	"time"
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
	fs.StringVar(&driver, "driver", "mysql", "mysql|postgres|sqlite")
	fs.StringVar(&dsn, "dsn", "", "bench database DSN URI for every runner (required by run)")
	fs.Parse(os.Args[2:])
	if driver != "mysql" && driver != "postgres" && driver != "sqlite" {
		must(fmt.Errorf("unsupported database %q", driver))
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
		if dsn == "" {
			usage()
		}
		out := filepath.Join(root, "tests", "conformance", "out", driverDir())
		must(os.MkdirAll(out, 0o755))
		if err := os.Mkdir(lockDir, 0o755); err != nil {
			must(fmt.Errorf("another conformance run holds %s: %w", lockDir, err))
		}
		held = true
		must(removeVerifiedOutputs(out))
		pending, err := os.MkdirTemp(out, ".run-")
		must(err)
		must(buildRunners(root))
		stateDB, err := openStateDatabase(driver, dsn)
		must(err)
		for _, language := range requiredLanguages {
			before, err := snapshotDatabase(stateDB, driver)
			must(err)
			counters, err := readCounters(stateDB, driver)
			must(err)
			first := filepath.Join(pending, language+".json")
			repeated := filepath.Join(pending, language+".repeat.json")
			runErr := runOne(root, first, language)
			restoreErr := restoreCounters(stateDB, driver, counters)
			must(errors.Join(runErr, restoreErr))
			after, err := snapshotDatabase(stateDB, driver)
			must(err)
			if before != after {
				must(fmt.Errorf("%s changed %s database state on first run", language, driver))
			}
			runErr = runOne(root, repeated, language)
			restoreErr = restoreCounters(stateDB, driver, counters)
			must(errors.Join(runErr, restoreErr))
			afterRepeat, err := snapshotDatabase(stateDB, driver)
			must(err)
			if before != afterRepeat {
				must(fmt.Errorf("%s changed %s database state on repeated run", language, driver))
			}
			must(compareRepeatedEvidence(first, repeated))
			must(os.Remove(repeated))
		}
		must(stateDB.Close())
		var files []string
		for _, l := range requiredLanguages {
			files = append(files, filepath.Join(pending, l+".json"))
		}
		if compare(root, files) != 0 {
			must(fmt.Errorf("conformance comparison failed; output retained in %s", pending))
		}
		for _, language := range requiredLanguages {
			must(os.Rename(filepath.Join(pending, language+".json"), filepath.Join(out, language+".json")))
		}
		must(os.Remove(pending))
		held = false
		must(os.Remove(lockDir))
		fmt.Printf("conformance: verified outputs saved in %s\n", out)
	case "compare":
		os.Exit(compare(root, fs.Args()))
	case "record":
		if len(fs.Args()) != 1 {
			usage()
		}
		record(root, fs.Args()[0])
	default:
		usage()
	}
}

const lockDir = "/tmp/orm-conformance.lock"

func driverDir() string {
	if driver == "mysql" {
		return ""
	}
	return driver
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: check state|run -dsn x [-driver mysql|postgres|sqlite] | check compare [-driver d] <go.json> <php.json> <rust.json> <typescript.json> | check record [-driver d] <out.json>")
	os.Exit(2)
}

// held is set while run owns the lock directory, so a failure releases it.
var held bool

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "check:", err)
		if held {
			if cleanupErr := os.Remove(lockDir); cleanupErr != nil {
				fmt.Fprintln(os.Stderr, "check: release conformance lock:", cleanupErr)
			}
		}
		os.Exit(1)
	}
}

func buildRunners(root string) error {
	if err := runCommand(root, "", 30*time.Minute, "cargo", "build", "--locked", "--release", "--manifest-path", "clients/rust/Cargo.toml", "-p", "orm-tests", "--bin", "conformance"); err != nil {
		return err
	}
	return runCommand(root, "", 10*time.Minute, "npm", "run", "build", "--prefix", "clients/typescript")
}

func runOne(root, output, language string) error {
	schema := filepath.Join(root, "schema", "schema.json")
	flags := []string{"--dsn", dsn}
	switch language {
	case "go":
		return runCommand(root, output, 10*time.Minute, "go", "run", "./tests/conformance/runner_go", "-driver", driver, "-dsn", dsn, schema)
	case "php":
		return runCommand(root, output, 10*time.Minute, "php", append([]string{"tests/conformance/runner.php", schema}, flags...)...)
	case "typescript":
		return runCommand(root, output, 10*time.Minute, "node", append(append([]string{"tests/conformance/runner_typescript.mjs"}, flags...), schema)...)
	case "rust":
		target := os.Getenv("CARGO_TARGET_DIR")
		if target == "" {
			target = filepath.Join(root, "clients", "rust", "target")
		} else if !filepath.IsAbs(target) {
			target = filepath.Join(root, target)
		}
		return runCommand(root, output, 10*time.Minute, filepath.Join(target, "release", "conformance"), append(flags, schema)...)
	default:
		return fmt.Errorf("unsupported language %q", language)
	}
}

func runCommand(root, output string, timeout time.Duration, name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = root
	cmd.Stderr = os.Stderr
	var buf bytes.Buffer
	if output == "" {
		cmd.Stdout = os.Stderr
	} else {
		cmd.Stdout = &buf
	}
	fmt.Fprintf(os.Stderr, "check: %s\n", displayCommand(cmd.Args))
	err := cmd.Run()
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
		if visible[i-1] == "--dsn" {
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
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("multiple JSON values")
		}
		return nil, err
	}
	return value, nil
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
func load(root string) file {
	b, err := os.ReadFile(filepath.Join(root, "tests/conformance/vectors.json"))
	must(err)
	var f file
	must(json.Unmarshal(b, &f))
	if driver == "mysql" {
		return f
	}
	recorded := map[string]json.RawMessage{}
	if b, err := os.ReadFile(filepath.Join(root, vectorsPath())); err == nil {
		var d file
		must(json.Unmarshal(b, &d))
		for _, v := range d.Vectors {
			recorded[v.Name] = v.Expect
		}
	}
	for i := range f.Vectors {
		f.Vectors[i].Expect = recorded[f.Vectors[i].Name]
	}
	return f
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
	f := load(root)
	type got map[string]json.RawMessage
	langs := []string{}
	results := map[string]got{}
	for _, p := range outputs {
		lang := strings.TrimSuffix(filepath.Base(p), ".json")
		b, err := os.ReadFile(p)
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

func record(root, output string) {
	f := load(root)
	b, err := os.ReadFile(output)
	must(err)
	var g map[string]json.RawMessage
	must(json.Unmarshal(b, &g))
	for i := range f.Vectors {
		r, ok := g[f.Vectors[i].Name]
		if !ok {
			must(fmt.Errorf("vector %s not in %s", f.Vectors[i].Name, output))
		}
		f.Vectors[i].Expect = json.RawMessage(canon(r))
	}
	for name := range g {
		found := false
		for _, v := range f.Vectors {
			found = found || v.Name == name
		}
		if !found {
			must(fmt.Errorf("output has vector %q that vectors.json does not declare", name))
		}
	}
	out, err := json.MarshalIndent(f, "", "  ")
	must(err)
	must(os.WriteFile(filepath.Join(root, vectorsPath()), append(out, '\n'), 0o644))
	fmt.Printf("recorded %d vectors from %s into %s\n", len(f.Vectors), output, vectorsPath())
}
