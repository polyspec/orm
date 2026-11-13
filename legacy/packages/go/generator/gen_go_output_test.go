package generator

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/legacy/packages/go/internal/testdb"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// generatedScannedModule creates a scanned module whose output package holds a
// hand-written file, generates its models, and returns the manifest.
func generatedScannedModule(t *testing.T) (func(name, body string), *runtimemodel.Model) {
	t.Helper()
	write := scannedModule(t)
	write("model/doc.go", "// Package model holds the generated models.\npackage model\n")
	write("example/example.go", `package example

import "example.com/ormexample/model"

func Cheap() *model.ProductModel { return model.Product().LtPrice(1) }
`)
	m := namesManifest(t, namesDiagram)
	if err := generateGo(m, "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	return write, m
}

// moreCalls is a scanned file whose calls add a method to the output.
const moreCalls = `package example

import "example.com/ormexample/model"

func Expensive() *model.ProductModel { return model.Product().GePrice(1) }
`

// snapshotDir returns the contents of the files of dir by name.
func snapshotDir(t *testing.T, dir string) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, entry := range entries {
		if entry.IsDir() {
			files[entry.Name()+"/"] = ""
			continue
		}
		body, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		files[entry.Name()] = string(body)
	}
	return files
}

// dirNames returns the sorted entry names of dir.
func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	return testdb.DirNames(t, dir)
}

func requireSameFiles(t *testing.T, want, got map[string]string) {
	t.Helper()
	var diff []string
	for name, body := range want {
		if other, ok := got[name]; !ok {
			diff = append(diff, "missing "+name)
		} else if other != body {
			diff = append(diff, "changed "+name)
		}
	}
	for name := range got {
		if _, ok := want[name]; !ok {
			diff = append(diff, "added "+name)
		}
	}
	if len(diff) > 0 {
		slices.Sort(diff)
		t.Fatalf("output directory differs:\n%s", strings.Join(diff, "\n"))
	}
}

// requireUnchanged runs a failing generation with the scan patterns, ./...
// by default, and checks that it reports a generation failure and leaves the
// output directory and its parent as they were.
func requireUnchanged(t *testing.T, m *runtimemodel.Model, message string, patterns ...string) {
	t.Helper()
	if len(patterns) == 0 {
		patterns = []string{"./..."}
	}
	before, parent := snapshotDir(t, "model"), dirNames(t, ".")
	err := generateGo(m, "model", "", patterns)
	requireSameFiles(t, before, snapshotDir(t, "model"))
	if after := dirNames(t, "."); !slices.Equal(parent, after) {
		t.Fatalf("the module directory changed: %v -> %v", parent, after)
	}
	var scanned *ScannedSourceError
	if err == nil || errors.As(err, &scanned) || !strings.Contains(err.Error(), message) || !strings.Contains(err.Error(), "model is unchanged") {
		t.Fatalf("want a generation failure containing %q, got %v", message, err)
	}
}

// TestGoGenerationKeepsOutputOnManifestError checks that a manifest rejected
// before the scan leaves the previous output byte-identical.
func TestGoGenerationKeepsOutputOnManifestError(t *testing.T) {
	testcase.Start(t, testcase.Process)
	generatedScannedModule(t)
	collision := namesManifest(t, "dbspec 1 names\n\ntable product {\n  seq i64 identity\n  amount i32\n  sum_amount i32\n  primary key (seq)\n}\n")
	requireUnchanged(t, collision, "fixed method")
}

// TestGoGenerationKeepsOutputOnGenerationError checks that an invalid model
// call leaves the previous output byte-identical.
func TestGoGenerationKeepsOutputOnGenerationError(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write, m := generatedScannedModule(t)
	write("example/more.go", moreCalls)
	write("example/bad.go", `package example

import "example.com/ormexample/model"

func Bad() *model.ProductModel { return model.Product().LkPrice("x") }
`)
	requireUnchanged(t, m, "does not accept")
}

// commandBinary builds the orm-gen command into a temporary directory and
// returns its path.
func commandBinary(t *testing.T) string {
	t.Helper()
	root := testcase.LegacyPath("packages/go")
	bin := filepath.Join(t.TempDir(), "orm-gen")
	build := exec.Command("go", "build", "-o", bin, "./cmd/orm-gen")
	build.Dir = root
	build.Env = append(os.Environ(), "GOWORK=off")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build orm-gen: %v\n%s", err, out)
	}
	return bin
}

// TestGoGenerationCommandReportsOutcomes checks the orm-gen gen exit status and
// messages of a scanned-source compile error and of a generation failure.
// Requirements: DSL-39.
func TestGoGenerationCommandReportsOutcomes(t *testing.T) {
	testcase.Start(t, testcase.Process)
	bin, write := namesCommand(t, false)
	write("dbspec-set.json", namesSet)
	run := func() (int, string, string) {
		return runTool(t, bin, "gen", "--set", "dbspec-set.json", "--lang", "go", "--out", "model", "--scan", "./...")
	}
	write("example/more.go", moreCalls)
	write("example/unrelated.go", "package example\n\nvar _ = missingName\n")
	code, stdout, stderr := run()
	if code != 3 || !strings.Contains(stdout, "entities → model (go)") || !strings.Contains(stderr, "the scanned packages do not compile with the generated models") || !strings.Contains(stderr, "missingName") {
		t.Fatalf("scanned-source compile error: exit %d\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	write("example/bad.go", `package example

import "example.com/ormexample/model"

func Bad() *model.ProductModel { return model.Product().LkPrice("x") }
`)
	code, stdout, stderr = run()
	if code != 1 || stdout != "" || !strings.Contains(stderr, "model is unchanged") || !strings.Contains(stderr, "does not accept") {
		t.Fatalf("generation failure: exit %d\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
}

// namesSet is the set file of a module whose only document is names.dbs.
const namesSet = `{"schema": 1, "documents": ["names.dbs"]}` + "\n"

// namesCommand returns the orm-gen binary and the writer of the scanned model
// module, with the names diagram and, when set is true, its dbspec set file.
func namesCommand(t *testing.T, set bool) (string, func(name, body string)) {
	t.Helper()
	bin := commandBinary(t)
	write, _ := generatedScannedModule(t)
	write("names.dbs", namesDiagram)
	if set {
		write("dbspec-set.json", namesSet)
	}
	return bin, write
}

// TestGoGenerationCommandRefusesTheRemovedDocumentFlags checks that orm-gen gen
// takes its documents only from the set file: the removed --schema and --use
// flags are usage errors that name the flag, and nothing is written.
// Requirements: ORES-21, DBS-5, DBS-98.
func TestGoGenerationCommandRefusesTheRemovedDocumentFlags(t *testing.T) {
	testcase.Start(t, testcase.Process)
	bin := commandBinary(t)
	root := testcase.LegacyRoot()
	set := filepath.Join(root, "contracts", "fixtures", "bench", "dbspec-set.json")
	document := filepath.Join(root, "contracts", "fixtures", "bench", "bench.dbs")
	for _, flag := range []string{"--schema", "--use"} {
		out := filepath.Join(t.TempDir(), "model")
		code, stdout, stderr := runTool(t, bin, "gen", "--set", set, flag, document, "--lang", "go", "--out", out)
		if code != 2 || stdout != "" || !strings.Contains(stderr, strings.TrimPrefix(flag, "--")) {
			t.Fatalf("%s: exit %d\nstdout: %s\nstderr: %s", flag, code, stdout, stderr)
		}
		if _, err := os.Stat(out); !os.IsNotExist(err) {
			t.Fatalf("%s: the refused generation wrote %s (%v)", flag, out, err)
		}
	}
}
