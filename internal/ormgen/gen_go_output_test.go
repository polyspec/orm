package ormgen

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

// generatedConsumer creates a consumer module whose output package holds a
// hand-written file, generates its models, and returns the manifest.
func generatedConsumer(t *testing.T) (func(name, body string), *schema.Manifest) {
	t.Helper()
	write := consumerModule(t)
	write("model/doc.go", "// Package model holds the generated models.\npackage model\n")
	write("app/app.go", `package app

import "example.com/app/model"

func Cheap() *model.ProductModel { return model.Product().LtPrice(1) }
`)
	m := namesManifest(t, namesDiagram)
	if err := generateGo(m, "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	return write, m
}

// moreCalls is a consumer file whose calls add a method to the output.
const moreCalls = `package app

import "example.com/app/model"

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
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
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
func requireUnchanged(t *testing.T, m *schema.Manifest, message string, patterns ...string) {
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
	var consumer *ConsumerError
	if err == nil || errors.As(err, &consumer) || !strings.Contains(err.Error(), message) || !strings.Contains(err.Error(), "model is unchanged") {
		t.Fatalf("want a generation failure containing %q, got %v", message, err)
	}
}

// TestGoGenerationKeepsOutputOnManifestError checks that a manifest rejected
// before the scan leaves the previous output byte-identical.
func TestGoGenerationKeepsOutputOnManifestError(t *testing.T) {
	generatedConsumer(t)
	collision := namesManifest(t, "erDiagram\n  product {\n    bigint seq PK \"auto\"\n    int amount\n    int sum_amount\n  }\n")
	requireUnchanged(t, collision, "fixed method")
}

// TestGoGenerationKeepsOutputOnGenerationError checks that an invalid model
// call leaves the previous output byte-identical.
func TestGoGenerationKeepsOutputOnGenerationError(t *testing.T) {
	write, m := generatedConsumer(t)
	write("app/more.go", moreCalls)
	write("app/bad.go", `package app

import "example.com/app/model"

func Bad() *model.ProductModel { return model.Product().LkPrice("x") }
`)
	requireUnchanged(t, m, "does not accept")
}

// TestGoGenerationKeepsOutputWhenScanDoesNotConverge checks that a scan that
// does not converge within its round limit leaves the previous output
// byte-identical.
func TestGoGenerationKeepsOutputWhenScanDoesNotConverge(t *testing.T) {
	write, m := generatedConsumer(t)
	write("app/more.go", moreCalls)
	limit := scanRounds
	scanRounds = 1
	t.Cleanup(func() { scanRounds = limit })
	requireUnchanged(t, m, "did not converge")
}

// TestGoGenerationKeepsOutputWhenScanCannotLoad checks that a scan that cannot
// load the consumer packages leaves the previous output byte-identical.
func TestGoGenerationKeepsOutputWhenScanCannotLoad(t *testing.T) {
	write, m := generatedConsumer(t)
	write("app/more.go", moreCalls)
	gomod, err := os.ReadFile("go.mod")
	if err != nil {
		t.Fatal(err)
	}
	write("go.mod", string(gomod)+"\nunknown example\n")
	requireUnchanged(t, m, "unknown directive")
}

// TestGoGenerationKeepsOutputWhenAScanPatternFails checks that a scan pattern
// that names no directory is a scan failure that leaves the previous output
// byte-identical.
func TestGoGenerationKeepsOutputWhenAScanPatternFails(t *testing.T) {
	write, m := generatedConsumer(t)
	write("app/more.go", moreCalls)
	requireUnchanged(t, m, "directory not found", "./...", "./missing")
}

// TestGoGenerationReplacesOutputAfterConvergence checks that a converged scan
// replaces every generated file, removes generated files of an earlier schema,
// keeps hand-written files, and leaves no temporary directory.
func TestGoGenerationReplacesOutputAfterConvergence(t *testing.T) {
	write, m := generatedConsumer(t)
	doc := snapshotDir(t, "model")["doc.go"]
	write("model/removed.go", generatedHeader+"\npackage model\n\nconst Removed = 1\n")
	write("app/more.go", moreCalls)
	parent := dirNames(t, ".")
	if err := generateGo(m, "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	got := snapshotDir(t, "model")
	if _, ok := got["removed.go"]; ok {
		t.Fatal("a generated file of an earlier schema was kept")
	}
	if got["doc.go"] != doc {
		t.Fatal("a hand-written file of the output package changed")
	}
	if !strings.Contains(got["product.go"], ") GePrice[") || !strings.Contains(got["product.go"], ") LtPrice[") {
		t.Fatal("the replaced output does not hold every called method")
	}
	if after := dirNames(t, "."); !slices.Equal(parent, after) {
		t.Fatalf("the module directory changed: %v -> %v", parent, after)
	}
	for name := range got {
		if name != "doc.go" {
			if err := os.Remove(filepath.Join("model", name)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := generateGo(m, "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	requireSameFiles(t, got, snapshotDir(t, "model"))
	buildConsumer(t)
}

// TestGoGenerationReportsConsumerErrorsWithCompleteOutput checks that a
// consumer compile error unrelated to the models is a distinct outcome and that
// the output directory holds the complete generated models.
func TestGoGenerationReportsConsumerErrorsWithCompleteOutput(t *testing.T) {
	write, m := generatedConsumer(t)
	write("app/more.go", moreCalls)
	write("app/unrelated.go", "package app\n\nvar _ = missingName\n")
	err := generateGo(m, "model", "", []string{"./..."})
	var consumer *ConsumerError
	if !errors.As(err, &consumer) || !strings.Contains(err.Error(), "missingName") {
		t.Fatalf("want a consumer compile error naming missingName, got %v", err)
	}
	withError := snapshotDir(t, "model")
	if err := os.Remove("app/unrelated.go"); err != nil {
		t.Fatal(err)
	}
	if err := generateGo(m, "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	requireSameFiles(t, snapshotDir(t, "model"), withError)
}

// TestGoGenerationCommandReportsOutcomes checks the ormgen gen exit status and
// messages of a consumer compile error and of a generation failure.
func TestGoGenerationCommandReportsOutcomes(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "ormgen")
	build := exec.Command("go", "build", "-o", bin, "./cmd/ormgen")
	build.Dir = root
	build.Env = append(os.Environ(), "GOWORK=off")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build ormgen: %v\n%s", err, out)
	}
	write, m := generatedConsumer(t)
	js, err := m.MarshalIndent()
	if err != nil {
		t.Fatal(err)
	}
	write("schema.json", string(js))
	run := func() (int, string, string) {
		t.Helper()
		var stdout, stderr bytes.Buffer
		cmd := exec.Command(bin, "gen", "--schema", "schema.json", "--lang", "go", "--out", "model", "--scan", "./...")
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		var exit *exec.ExitError
		if err != nil && !errors.As(err, &exit) {
			t.Fatal(err)
		}
		return cmd.ProcessState.ExitCode(), stdout.String(), stderr.String()
	}
	write("app/more.go", moreCalls)
	write("app/unrelated.go", "package app\n\nvar _ = missingName\n")
	code, stdout, stderr := run()
	if code != 3 || !strings.Contains(stdout, "entities → model (go)") || !strings.Contains(stderr, "the scanned packages do not compile with the generated models") || !strings.Contains(stderr, "missingName") {
		t.Fatalf("consumer compile error: exit %d\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	write("app/bad.go", `package app

import "example.com/app/model"

func Bad() *model.ProductModel { return model.Product().LkPrice("x") }
`)
	code, stdout, stderr = run()
	if code != 1 || stdout != "" || !strings.Contains(stderr, "model is unchanged") || !strings.Contains(stderr, "does not accept") {
		t.Fatalf("generation failure: exit %d\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
}
