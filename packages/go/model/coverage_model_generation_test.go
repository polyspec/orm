//go:build featurecoverage

package model_test

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// modelsFile is the declared entries of the Go models, relative to packages/go, read by make go-models and make go-model-check.
const modelsFile = "models.txt"

// modelEntries reads the entries of the Go models from packages/go/models.txt: each line that is not a comment is the
// argument list of one orm-gen gen run from packages/go.
func modelEntries(t *testing.T) [][]string {
	t.Helper()
	source, err := os.ReadFile(filepath.Join("..", modelsFile))
	if err != nil {
		t.Fatal(err)
	}
	var entries [][]string
	for _, line := range strings.Split(string(source), "\n") {
		if strings.TrimSpace(line) == "" || strings.HasPrefix(line, "#") {
			continue
		}
		entries = append(entries, strings.Fields(line))
	}
	if len(entries) == 0 {
		t.Fatalf("%s declares no entry", modelsFile)
	}
	return entries
}

// modelEntry returns the entry that writes the model package, the one whose output is ./model.
func modelEntry(t *testing.T, entries [][]string) []string {
	t.Helper()
	for _, entry := range entries {
		for i := 0; i+1 < len(entry); i++ {
			if entry[i] == "--out" && entry[i+1] == "./model" {
				return entry
			}
		}
	}
	t.Fatalf("%s declares no entry with --out ./model", modelsFile)
	return nil
}

// genCommand is the orm-gen command that writes one entry of the Go models, run from packages/go.
func genCommand(entry []string) []string {
	return append([]string{"go", "run", "./cmd/orm-gen", "gen", "--lang", "go"}, entry...)
}

// runCheck runs the generation command with --check in dir and returns the stdout, stderr, and exit
// code.
func runCheck(t *testing.T, dir string, command []string) (string, string, int) {
	t.Helper()
	cmd := exec.Command(command[0], append(command[1:], "--check")...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return stdout.String(), stderr.String(), 0
	case errors.As(err, &exit):
		return stdout.String(), stderr.String(), exit.ExitCode()
	}
	t.Fatalf("%q: %v", command, err)
	return "", "", 0
}

// copyModule copies into dst the Go source of the module parts that the generation command reads:
// go.work, the go.mod and go.sum of its three modules, the packages/go modules (orm-gen, generator, engine,
// the Go client), plus the examples that scan reads, the Go conformance runner, and the documents of the bench set
// directory contracts/fixtures/bench, which the set files list.
func copyModule(t *testing.T, root, dst string) {
	t.Helper()
	files := []string{"go.work"}
	for _, module := range []string{filepath.Join("packages", "go"), "tests", "examples"} {
		files = append(files, filepath.Join(module, "go.mod"), filepath.Join(module, "go.sum"))
	}
	for _, file := range files {
		copyFile(t, filepath.Join(root, file), filepath.Join(dst, file))
	}
	bench := filepath.Join("contracts", "fixtures", "bench")
	documents, err := os.ReadDir(filepath.Join(root, bench))
	if err != nil {
		t.Fatal(err)
	}
	for _, document := range documents {
		if !document.IsDir() {
			copyFile(t, filepath.Join(root, bench, document.Name()), filepath.Join(dst, bench, document.Name()))
		}
	}
	for _, dir := range []string{filepath.Join("packages", "go"), "examples", filepath.Join("packages", "go", "internal", "conformance")} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.Type()&fs.ModeSymlink != 0 {
				return errors.New("symbolic link " + path)
			}
			if entry.IsDir() || filepath.Ext(path) != ".go" {
				return nil
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			copyFile(t, path, filepath.Join(dst, rel))
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestCoverageModelGenerationCheck checks that the committed models are the same as the output of each declared
// entry of models.txt, and that check reports a copy of the model package with one changed byte as different,
// and verifies this.
func TestCoverageModelGenerationCheck(t *testing.T) {
	testcase.Start(t, testcase.Process)
	entries := modelEntries(t)
	for _, entry := range entries {
		if stdout, stderr, code := runCheck(t, "..", genCommand(entry)); code != 0 || stdout != "" || stderr != "" {
			t.Fatalf("check of the committed models of %q exited %d:\n%s%s", entry, code, stdout, stderr)
		}
	}
	command := genCommand(modelEntry(t, entries))

	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	copied := t.TempDir()
	copyModule(t, root, copied)
	dir := filepath.Join(copied, "packages", "go")
	target := filepath.Join(dir, "model", "author.go")
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	// Changes one character of the comment after the first-line generated header.
	at := bytes.Index(data, []byte("\n// "))
	if at < 0 || at+4 >= len(data) || data[at+4] < 'A' || data[at+4] > 'z' {
		t.Fatal("author.go has no comment letter after its header")
	}
	data[at+4] ^= 0x20
	if err := os.WriteFile(target, data, 0o644); err != nil {
		t.Fatal(err)
	}
	// check writes the difference to stdout and exits with 1, and go run reports that exit status on stderr.
	if stdout, stderr, code := runCheck(t, dir, command); code != 1 || stdout != "differs: model/author.go\n" || stderr != "exit status 1\n" {
		t.Fatalf("check of the changed copy exited %d:\n%s%s", code, stdout, stderr)
	}
}
