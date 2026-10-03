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

	"github.com/polyspec/orm/internal/testcase"
)

// generateCommand는 generate.go의 go:generate 줄에 선언된 생성 명령이다.
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

// runCheck는 생성 명령을 --check로 dir에서 실행하고 stdout, stderr, exit
// code를 반환한다.
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

// copyModule는 생성 명령이 읽는 module 부분의 Go source를 dst에 복사한다:
// go.mod, go.sum, orm-gen과 generator, engine, Go client, 그리고 scan이 읽는
// examples와 Go conformance runner, document schema/bench.dbs.
func copyModule(t *testing.T, root, dst string) {
	t.Helper()
	for _, file := range []string{"go.mod", "go.sum", filepath.Join("schema", "bench.dbs")} {
		copyFile(t, filepath.Join(root, file), filepath.Join(dst, file))
	}
	for _, dir := range []string{"cmd", "generator", "engine", filepath.Join("clients", "go"), "examples", filepath.Join("tests", "conformance", "runner_go")} {
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

// TestCoverageModelGenerationCheck는 commit된 model이 선언된 생성 명령의
// 출력과 같다고 check가 알리고, 한 byte를 바꾼 복사본은 다르다고 알리는지
// 확인한다.
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
	dir := filepath.Join(copied, "clients", "go", "model")
	target := filepath.Join(dir, "author.go")
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	// 첫 줄 generated header 다음 주석의 한 글자를 바꾼다.
	at := bytes.Index(data, []byte("\n// "))
	if at < 0 || at+4 >= len(data) || data[at+4] < 'A' || data[at+4] > 'z' {
		t.Fatal("author.go has no comment letter after its header")
	}
	data[at+4] ^= 0x20
	if err := os.WriteFile(target, data, 0o644); err != nil {
		t.Fatal(err)
	}
	// check는 차이를 stdout에 쓰고 1로 끝나며, go run은 그 exit status를 stderr에 알린다.
	if stdout, stderr, code := runCheck(t, dir, command); code != 1 || stdout != "differs: author.go\n" || stderr != "exit status 1\n" {
		t.Fatalf("check of the changed copy exited %d:\n%s%s", code, stdout, stderr)
	}
}
