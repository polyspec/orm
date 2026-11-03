package generator

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Tests of how the Go generator stages, replaces and keeps its output directory around go/packages scanning.

// TestGoGenerationStagesBesideItsOutput checks that generation stages files
// beside its output without changing the existing output before replacement.
func TestGoGenerationStagesBesideItsOutput(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write, manifest := generatedScannedModule(t)
	before := snapshotDir(t, "model")
	write("example/more.go", moreCalls)
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	stagePaths := func() []string {
		t.Helper()
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatal(err)
		}
		var stages []string
		for _, entry := range entries {
			if entry.IsDir() && strings.HasPrefix(entry.Name(), ".orm-gen-model-") {
				stages = append(stages, filepath.Join(root, entry.Name()))
			}
		}
		return stages
	}
	if stages := stagePaths(); len(stages) != 0 {
		t.Fatalf("generation left temporary paths before it started: %v", stages)
	}
	var during [][]string
	scanLoads = func(scanConfig, []string) {
		stages := stagePaths()
		if len(stages) != 1 {
			t.Errorf("during scan, staging paths = %v, want one sibling of the output", stages)
			return
		}
		if filepath.Dir(stages[0]) != root {
			t.Errorf("staging path %s is not beside output directory %s", stages[0], filepath.Join(root, "model"))
		}
		requireSameFiles(t, before, snapshotDir(t, "model"))
		during = append(during, stages)
	}
	t.Cleanup(func() { scanLoads = nil })
	if err := generateGo(manifest, "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	if len(during) == 0 {
		t.Fatal("the generation loaded no scanned package, so nothing observed the staging directory")
	}
	if stages := stagePaths(); len(stages) != 0 {
		t.Fatalf("generation left staging paths after it finished: %v", stages)
	}
	if got := snapshotDir(t, "model"); got["product.go"] == before["product.go"] {
		t.Fatal("generation did not replace the output after scan convergence")
	}
}

// TestGoGenerationCleansMissingOutputParentsOnFailure checks nested output
// support and removes directories created only for a failed generation.
func TestGoGenerationCleansMissingOutputParentsOnFailure(t *testing.T) {
	testcase.Start(t, testcase.Process)
	scannedModule(t)
	out := filepath.Join("created", "nested", "model")
	manifest := namesManifest(t, namesDiagram)
	commitFailure := errors.New("injected commit failure")
	err := runGo(manifest, out, "", nil, func(*goGen) error { return commitFailure })
	if !errors.Is(err, commitFailure) {
		t.Fatalf("generation failure = %v, want injected commit failure", err)
	}
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), ".orm-gen-model-") {
			t.Fatalf("failed generation left staging directory %s", entry.Name())
		}
	}
	if _, err := os.Stat("created"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed generation left its newly created parent: %v", err)
	}
	if err := generateGo(manifest, out, "", nil); err != nil {
		t.Fatalf("generation to a nested output directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(out, "product.go")); err != nil {
		t.Fatalf("nested output is missing generated model: %v", err)
	}
}

// TestGoGenerationKeepsOutputWhenScanDoesNotConverge checks that a scan that
// does not converge within its round limit leaves the previous output
// byte-identical.
func TestGoGenerationKeepsOutputWhenScanDoesNotConverge(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write, m := generatedScannedModule(t)
	write("example/more.go", moreCalls)
	limit := scanRounds
	scanRounds = 1
	t.Cleanup(func() { scanRounds = limit })
	requireUnchanged(t, m, "did not converge")
}

// TestGoGenerationKeepsOutputWhenScanCannotLoad checks that a scan that cannot
// load the scanned packages leaves the previous output byte-identical.
func TestGoGenerationKeepsOutputWhenScanCannotLoad(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write, m := generatedScannedModule(t)
	write("example/more.go", moreCalls)
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
	testcase.Start(t, testcase.Process)
	write, m := generatedScannedModule(t)
	write("example/more.go", moreCalls)
	requireUnchanged(t, m, "directory not found", "./...", "./missing")
}

// TestGoGenerationReplacesOutputAfterConvergence checks that a converged scan
// replaces every generated file, removes generated files of an earlier schema,
// keeps hand-written files, and leaves no temporary directory.
func TestGoGenerationReplacesOutputAfterConvergence(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write, m := generatedScannedModule(t)
	doc := snapshotDir(t, "model")["doc.go"]
	write("model/removed.go", generatedHeader+"\npackage model\n\nconst Removed = 1\n")
	write("example/more.go", moreCalls)
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
	buildScannedModule(t)
}

// TestGoGenerationReportsScannedSourceErrorsWithCompleteOutput checks that a
// scanned-source compile error unrelated to the models is a distinct outcome and that
// the output directory holds the complete generated models.
func TestGoGenerationReportsScannedSourceErrorsWithCompleteOutput(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write, m := generatedScannedModule(t)
	write("example/more.go", moreCalls)
	write("example/unrelated.go", "package example\n\nvar _ = missingName\n")
	err := generateGo(m, "model", "", []string{"./..."})
	var scanned *ScannedSourceError
	if !errors.As(err, &scanned) || !strings.Contains(err.Error(), "missingName") {
		t.Fatalf("want a scanned-source compile error naming missingName, got %v", err)
	}
	withError := snapshotDir(t, "model")
	if err := os.Remove("example/unrelated.go"); err != nil {
		t.Fatal(err)
	}
	if err := generateGo(m, "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	requireSameFiles(t, snapshotDir(t, "model"), withError)
}
