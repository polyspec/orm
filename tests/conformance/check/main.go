// Conformance checker: runs the three runners (or reads their outputs) and
// compares each vector's statements and result against tests/conformance/vectors.json
// after canonicalizing the JSON (sorted keys, shortest numbers).
//
//	go run ./tests/conformance/check run              # build/run all three runners, then compare
//	go run ./tests/conformance/check compare out/…    # compare already-produced outputs (<lang>.json)
//	go run ./tests/conformance/check record out/go.json  # fill vectors.json expectations from one output
//
// The PHP runner needs ormd: `run` starts it on a socket under the output
// directory and waits for its "listening" line (no polling), then stops it.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
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

const vectorsPath = "tests/conformance/vectors.json"

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	root, err := os.Getwd()
	must(err)
	switch os.Args[1] {
	case "run":
		out := filepath.Join(root, "tests", "conformance", "out")
		must(os.MkdirAll(out, 0o755))
		runAll(root, out)
		os.Exit(compare(root, []string{filepath.Join(out, "go.json"), filepath.Join(out, "php.json"), filepath.Join(out, "rust.json")}))
	case "compare":
		os.Exit(compare(root, os.Args[2:]))
	case "record":
		if len(os.Args) != 3 {
			usage()
		}
		record(root, os.Args[2])
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: check run | check compare <lang>.json... | check record <out.json>")
	os.Exit(2)
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "check:", err)
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
	capture(filepath.Join(out, "go.json"), exec.Command("go", "run", "./tests/conformance/runner_go", schema))
	capture(filepath.Join(out, "rust.json"), exec.Command(filepath.Join(root, "clients", "rust", "target", "release", "conformance"), filepath.Join(root, "bin", "ormengine.wasm"), schema))

	sock := filepath.Join(out, "ormd.sock")
	_ = os.Remove(sock)
	ormd := exec.Command(filepath.Join(root, "bin", "ormd"), "-socket", sock, "-schema", schema)
	stderr, err := ormd.StderrPipe()
	must(err)
	must(ormd.Start())
	// ormd prints one line once the socket is bound; block on it (never poll the filesystem).
	sc := bufio.NewScanner(stderr)
	ready := false
	for sc.Scan() {
		if strings.Contains(sc.Text(), "listening on") {
			ready = true
			break
		}
	}
	if !ready {
		_ = ormd.Process.Kill()
		must(fmt.Errorf("ormd did not report listening"))
	}
	go func() { // drain the rest so ormd never blocks on a full pipe
		for sc.Scan() {
		}
	}()
	capture(filepath.Join(out, "php.json"), exec.Command("php", "tests/conformance/runner.php", sock, schema))
	must(ormd.Process.Kill())
	_ = ormd.Wait()
	_ = os.Remove(sock)
}

func load(root string) file {
	b, err := os.ReadFile(filepath.Join(root, vectorsPath))
	must(err)
	var f file
	must(json.Unmarshal(b, &f))
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
	for _, v := range f.Vectors {
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
	must(os.WriteFile(filepath.Join(root, vectorsPath), append(out, '\n'), 0o644))
	fmt.Printf("recorded %d vectors from %s\n", len(f.Vectors), output)
}
