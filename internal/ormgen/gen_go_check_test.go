package ormgen

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"slices"
	"testing"
)

// requireCheck runs a Go generation check with the ./... scan and checks the
// reported lines and that the output directory and its parent are unchanged.
func requireCheck(t *testing.T, want ...string) {
	t.Helper()
	m := namesManifest(t, namesDiagram)
	before, parent := snapshotDir(t, "model"), dirNames(t, ".")
	got, err := checkGo(m, "model", []string{"./..."})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("check lines:\n got %q\nwant %q", got, want)
	}
	requireSameFiles(t, before, snapshotDir(t, "model"))
	if after := dirNames(t, "."); !slices.Equal(parent, after) {
		t.Fatalf("the module directory changed: %v -> %v", parent, after)
	}
}

// TestGoGenerationCheckReportsDifferences checks that a check reports no line
// for current models and reports a changed, a missing, and an extra generated
// file without writing, while hand-written files are not compared.
func TestGoGenerationCheckReportsDifferences(t *testing.T) {
	write, _ := generatedConsumer(t)
	requireCheck(t)
	write("model/notes.go", "package model\n\nconst Notes = 1\n")
	requireCheck(t)
	write("app/more.go", moreCalls)
	write("model/removed.go", generatedHeader+"\npackage model\n\nconst Removed = 1\n")
	if err := os.Remove("model/brand.go"); err != nil {
		t.Fatal(err)
	}
	requireCheck(t, "missing: model/brand.go", "differs: model/product.go", "extra: model/removed.go")
}

// TestGoGenerationCheckReportsAHandWrittenFileOfAGeneratedName checks that a
// file without the generated header whose name the generation writes differs.
func TestGoGenerationCheckReportsAHandWrittenFileOfAGeneratedName(t *testing.T) {
	write, _ := generatedConsumer(t)
	write("model/brand.go", "package model\n")
	requireCheck(t, "differs: model/brand.go")
}

// TestGoGenerationCheckKeepsOutputOnGenerationError checks that a check whose
// generation fails reports the failure and writes nothing.
func TestGoGenerationCheckKeepsOutputOnGenerationError(t *testing.T) {
	write, m := generatedConsumer(t)
	write("app/bad.go", `package app

import "example.com/app/model"

func Bad() *model.ProductModel { return model.Product().LkPrice("x") }
`)
	before := snapshotDir(t, "model")
	_, err := checkGo(m, "model", []string{"./..."})
	var consumer *ConsumerError
	if err == nil || errors.As(err, &consumer) {
		t.Fatalf("want a generation failure, got %v", err)
	}
	requireSameFiles(t, before, snapshotDir(t, "model"))
}

// TestGoGenerationCheckCommandsReportDifferences checks the output and exit
// status of ormgen build --check and ormgen gen --check.
func TestGoGenerationCheckCommandsReportDifferences(t *testing.T) {
	bin := ormgenBinary(t)
	write, m := generatedConsumer(t)
	write("schema.mmd", namesDiagram)
	js, err := m.MarshalIndent()
	if err != nil {
		t.Fatal(err)
	}
	write("schema.json", string(js)+"\n")
	run := func(args ...string) (int, string, string) {
		t.Helper()
		var stdout, stderr bytes.Buffer
		cmd := exec.Command(bin, args...)
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		var exit *exec.ExitError
		if err != nil && !errors.As(err, &exit) {
			t.Fatal(err)
		}
		return cmd.ProcessState.ExitCode(), stdout.String(), stderr.String()
	}
	build := []string{"build", "schema.mmd", "--out", "schema.json", "--check"}
	gen := []string{"gen", "--schema", "schema.json", "--lang", "go", "--out", "model", "--scan", "./...", "--check"}
	for _, args := range [][]string{build, gen, {"build", "--check", "schema.mmd", "--out", "schema.json"}} {
		if code, stdout, stderr := run(args...); code != 0 || stdout != "" || stderr != "" {
			t.Fatalf("%v on current files: exit %d\nstdout: %s\nstderr: %s", args, code, stdout, stderr)
		}
	}
	write("schema.json", string(js))
	write("app/more.go", moreCalls)
	before := snapshotDir(t, "model")
	if code, stdout, stderr := run(build...); code != 1 || stdout != "differs: schema.json\n" || stderr != "" {
		t.Fatalf("build --check on a changed file: exit %d\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	if code, stdout, stderr := run(gen...); code != 1 || stdout != "differs: model/product.go\n" || stderr != "" {
		t.Fatalf("gen --check on a changed file: exit %d\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	requireSameFiles(t, before, snapshotDir(t, "model"))
	if b, err := os.ReadFile("schema.json"); err != nil || string(b) != string(js) {
		t.Fatalf("build --check wrote schema.json: %v", err)
	}
	if err := os.Remove("schema.json"); err != nil {
		t.Fatal(err)
	}
	if code, stdout, _ := run(build...); code != 1 || stdout != "missing: schema.json\n" {
		t.Fatalf("build --check on a missing file: exit %d\nstdout: %s", code, stdout)
	}
}
