package orm_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestExternalModuleCanImportClient checks the Go module package as a consumer receives it. A module of its own requires the
// module made of the tracked files of legacy/packages/go alone, since a generated file is ignored by git and so is not in the
// published module; it imports each Go root of contracts/interfaces.json that has a tracked source and passes go mod tidy and
// go build. go mod tidy also loads the tests of the packages that the consumer imports, so a test of a published package that
// imports a generated package fails here, as it fails in every consumer of the release.
// Requirements: INT-138.
func TestExternalModuleCanImportClient(t *testing.T) {
	testcase.Start(t, testcase.Process)
	if orm.IsDeadlock(nil) {
		t.Fatal("nil error reported as a deadlock")
	}
	const modulePath = "github.com/polyspec/orm/legacy/packages/go"
	root := testcase.RepositoryRoot()
	tracked := entryCommand(t, root, nil, "git", "ls-files", "-z", "--", "legacy/packages/go")
	module := filepath.Join(t.TempDir(), "module")
	sources := map[string]bool{}
	for _, file := range strings.Split(strings.TrimSuffix(tracked, "\x00"), "\x00") {
		data, err := os.ReadFile(filepath.Join(root, file))
		if err != nil {
			t.Fatalf("read the tracked file %s: %v", file, err)
		}
		target := filepath.Join(module, filepath.FromSlash(file))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(file, ".go") && !strings.HasSuffix(file, "_test.go") {
			sources[filepath.ToSlash(filepath.Dir(file))] = true
		}
	}
	data, err := os.ReadFile(filepath.Join(root, "contracts", "interfaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Languages struct {
			Go struct {
				Roots []string `json:"roots"`
			} `json:"go"`
		} `json:"languages"`
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatalf("contracts/interfaces.json: %v", err)
	}
	var imports bytes.Buffer
	for _, path := range contract.Languages.Go.Roots {
		if !strings.HasPrefix(path, "legacy/packages/go/") {
			t.Fatalf("the Go root %s of contracts/interfaces.json is outside legacy/packages/go", path)
		}
		if sources[path] {
			fmt.Fprintf(&imports, "\t_ %q\n", modulePath+strings.TrimPrefix(path, "legacy/packages/go"))
		}
	}
	if imports.Len() == 0 {
		t.Fatalf("no Go root of contracts/interfaces.json has a tracked source: %v", contract.Languages.Go.Roots)
	}
	manifest, err := os.ReadFile(filepath.Join(module, "legacy", "packages", "go", "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	goVersion := ""
	for _, line := range strings.Split(string(manifest), "\n") {
		if version, ok := strings.CutPrefix(line, "go "); ok {
			goVersion = strings.TrimSpace(version)
		}
	}
	if goVersion == "" {
		t.Fatal("legacy/packages/go/go.mod states no go version")
	}
	consumer := filepath.Join(t.TempDir(), "consumer")
	files := map[string]string{
		"go.mod": fmt.Sprintf("module example.com/consumer\n\ngo %s\n\nrequire %s v0.0.0\n\nreplace %s => %s\n",
			goVersion, modulePath, modulePath, filepath.ToSlash(filepath.Join(module, "legacy", "packages", "go"))),
		"main.go": "package main\n\nimport (\n" + imports.String() + ")\n\nfunc main() {}\n",
	}
	if err := os.MkdirAll(consumer, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(consumer, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	env := []string{"GOWORK=off", "GOFLAGS=-mod=mod"}
	entryCommand(t, consumer, env, "go", "mod", "tidy")
	entryCommand(t, consumer, env, "go", "build", "./...")
}

// entryCommand runs a command in dir with the environment of the test and env, and returns its standard output; a failure fails
// the test with its standard error.
func entryCommand(t *testing.T, dir string, env []string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%s %s in %s: %v\n%s", name, strings.Join(args, " "), dir, err, stderr.String())
	}
	return string(out)
}
