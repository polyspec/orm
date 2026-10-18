//go:build examples

package examples_test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestExampleOutputsAreIdentical checks, as the README compares them with diff, that the Go, PHP,
// and Rust programs of each example print the same stdout byte for byte on the seeded bench database.
// The Rust program paths are declared by EXAMPLE_RUST_COMPLEX and EXAMPLE_RUST_DEMO.
func TestExampleOutputsAreIdentical(t *testing.T) {
	testcase.Group(t)
	if os.Getenv("ORM_BENCH_MYSQL_DSN") == "" {
		t.Fatal("ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run")
	}
	examples := map[string]string{"complex": "EXAMPLE_RUST_COMPLEX", "thin-slice": "EXAMPLE_RUST_DEMO"}
	for name, rustVar := range examples {
		t.Run(name, func(t *testing.T) {
			// One example builds the Go program and runs the three programs once each.
			c := testcase.Start(t, testcase.Process)
			rust := os.Getenv(rustVar)
			if rust == "" {
				t.Fatalf("%s is required; it names the built Rust %s program; run make example-check, which builds it", rustVar, name)
			}
			bin := filepath.Join(t.TempDir(), name)
			if out, err := exec.CommandContext(c.Context(), "go", "build", "-o", bin, "./"+name+"/go").CombinedOutput(); err != nil {
				t.Fatalf("build %s: %v\n%s", name, err, out)
			}
			goOut := runExample(t, c, "go", bin)
			phpOut := runExample(t, c, "php", "php", filepath.Join(name, "php", "main.php"))
			rustOut := runExample(t, c, "rust", rust)
			if !bytes.Equal(goOut, phpOut) {
				t.Errorf("%s: go and php outputs differ\n--- go\n%s\n--- php\n%s", name, goOut, phpOut)
			}
			if name == "thin-slice" {
				// The TypeScript and Python programs run on the Node and the venv interpreter that install-python makes.
				tsOut := runExample(t, c, "ts", "node", filepath.Join(name, "ts", "main.mts"))
				pyOut := runExample(t, c, "python", filepath.Join("..", "packages", "python", ".venv", "bin", "python"), filepath.Join("..", "packages", "python", "examples", "thin_slice", "main.py"))
				if !bytes.Equal(goOut, tsOut) {
					t.Errorf("%s: go and ts outputs differ\n--- go\n%s\n--- ts\n%s", name, goOut, tsOut)
				}
				if !bytes.Equal(goOut, pyOut) {
					t.Errorf("%s: go and python outputs differ\n--- go\n%s\n--- python\n%s", name, goOut, pyOut)
				}
			}
			if !bytes.Equal(goOut, rustOut) {
				t.Errorf("%s: go and rust outputs differ\n--- go\n%s\n--- rust\n%s", name, goOut, rustOut)
			}
		})
	}
}

// runExample runs one program, returns its stdout, and records its run time.
func runExample(t *testing.T, c *testcase.Case, lang string, args ...string) []byte {
	t.Helper()
	start := time.Now()
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(c.Context(), args[0], args[1:]...)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("%s: %v\n%s", lang, err, stderr.String())
	}
	c.Step("%s: %d bytes in %s", lang, stdout.Len(), time.Since(start).Round(time.Millisecond))
	return stdout.Bytes()
}
