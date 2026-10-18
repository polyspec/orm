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

// generateCommand is the generation command declared on the go:generate line of generate.go.
func generateCommand(t *testing.T) []string {
	t.Helper()
	source, err := os.ReadFile("generate.go")
	if err != nil {
		t.Fatal(err)
	}
	var command []string
	for _, line := range strings.Split(string(source), "\n") {
		if rest, ok := strings.CutPrefix(line, "//go:generate "); ok {
			if command != nil {
				t.Fatal("generate.go declares more than one go:generate command")
			}
			command = strings.Fields(rest)
		}
	}
	if len(command) < 3 || command[0] != "go" || command[1] != "run" {
		t.Fatalf("generate.go declares no go run command: %q", command)
	}
	return command
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
// the Go client), plus the examples that scan reads, the Go conformance runner, and the set file
// contracts/fixtures/bench/dbspec-set.json and the document it lists, contracts/fixtures/bench/bench.dbs.
func copyModule(t *testing.T, root, dst string) {
	t.Helper()
	files := []string{"go.work", filepath.Join("contracts", "fixtures", "bench", "dbspec-set.json"), filepath.Join("contracts", "fixtures", "bench", "bench.dbs")}
	for _, module := range []string{filepath.Join("packages", "go"), "tests", "examples"} {
		files = append(files, filepath.Join(module, "go.mod"), filepath.Join(module, "go.sum"))
	}
	for _, file := range files {
		copyFile(t, filepath.Join(root, file), filepath.Join(dst, file))
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

// TestCoverageModelGenerationCheck checks that the committed model is the same as the output of the declared
// generation command, and that check reports a copy with one changed byte as different,
// and verifies this.
func TestCoverageModelGenerationCheck(t *testing.T) {
	testcase.Start(t, testcase.Process)
	command := generateCommand(t)
	if stdout, stderr, code := runCheck(t, ".", command); code != 0 || stdout != "" || stderr != "" {
		t.Fatalf("check of the committed models exited %d:\n%s%s", code, stdout, stderr)
	}

	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	copied := t.TempDir()
	copyModule(t, root, copied)
	dir := filepath.Join(copied, "packages", "go", "model")
	target := filepath.Join(dir, "author.go")
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
	if stdout, stderr, code := runCheck(t, dir, command); code != 1 || stdout != "differs: author.go\n" || stderr != "exit status 1\n" {
		t.Fatalf("check of the changed copy exited %d:\n%s%s", code, stdout, stderr)
	}
}
