// Conformance checker: runs the client runners (or reads their outputs) and
// compares each vector's statements and result against tests/conformance/vectors.json
// after canonicalizing the JSON (sorted keys, shortest numbers).
//
//	go run ./tests/conformance/check run -dsn … [-driver postgres|sqlite -langs go,php,rust]  # run runners, then compare
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
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	langs  string
)

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
	fs.StringVar(&langs, "langs", "go,php,rust,typescript", "runners to execute")
	fs.Parse(os.Args[2:])
	root, err := os.Getwd()
	must(err)
	switch os.Args[1] {
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
		runAll(root, out)
		held = false
		must(os.Remove(lockDir))
		var files []string
		for _, l := range strings.Split(langs, ",") {
			files = append(files, filepath.Join(out, l+".json"))
		}
		os.Exit(compare(root, files))
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
	fmt.Fprintln(os.Stderr, "usage: check run -dsn x [-driver d -langs go,php,rust,typescript] | check compare [-driver d] <lang>.json... | check record [-driver d] <out.json>")
	os.Exit(2)
}

// held is set while run owns the lock directory, so a failure releases it.
var held bool

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "check:", err)
		if held {
			_ = os.Remove(lockDir)
		}
		os.Exit(1)
	}
}

func runAll(root, out string) {
	schema := filepath.Join(root, "schema", "schema.json")
	capture := func(path string, cmd *exec.Cmd) {
		cmd.Dir = root
		cmd.Stderr = os.Stderr
		var buf bytes.Buffer
		cmd.Stdout = &buf
		fmt.Fprintf(os.Stderr, "check: %s\n", strings.Join(cmd.Args, " "))
		must(cmd.Run())
		must(os.WriteFile(path, buf.Bytes(), 0o644))
	}
	want := map[string]bool{}
	for _, l := range strings.Split(langs, ",") {
		want[l] = true
	}
	build := func(cmd *exec.Cmd) {
		cmd.Dir = root
		cmd.Stdout = os.Stderr
		cmd.Stderr = os.Stderr
		fmt.Fprintf(os.Stderr, "check: %s\n", strings.Join(cmd.Args, " "))
		must(cmd.Run())
	}
	if want["rust"] {
		build(exec.Command("cargo", "build", "--locked", "--release", "--manifest-path", "clients/rust/Cargo.toml", "-p", "orm-tests", "--bin", "conformance"))
	}
	if want["typescript"] {
		build(exec.Command("npm", "run", "build", "--prefix", "clients/typescript"))
	}
	flags := []string{"--dsn", dsn}
	if want["go"] {
		capture(filepath.Join(out, "go.json"), exec.Command("go", "run", "./tests/conformance/runner_go", "-driver", driver, "-dsn", dsn, schema))
	}
	if want["php"] {
		capture(filepath.Join(out, "php.json"), exec.Command("php", append([]string{"tests/conformance/runner.php", schema}, flags...)...))
	}
	if want["typescript"] {
		capture(filepath.Join(out, "typescript.json"), exec.Command("node", append(append([]string{"tests/conformance/runner_typescript.mjs"}, flags...), schema)...))
	}
	if want["rust"] {
		capture(filepath.Join(out, "rust.json"), exec.Command(filepath.Join(root, "clients", "rust", "target", "release", "conformance"), append(flags, schema)...))
	}
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

// canon re-encodes JSON with sorted keys and Go's shortest number form, so
// 48000 == 48000.0 and key order never matters.
func canon(raw json.RawMessage) string {
	var v any
	must(json.Unmarshal(raw, &v))
	b, err := json.MarshalIndent(v, "", "  ")
	must(err)
	return string(b)
}

func compare(root string, outputs []string) int {
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
			if got := canon(g); got != want {
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
