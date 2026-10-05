//go:build examples

package examples_test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/polyspec/orm/internal/testcase"
)

// TestExampleOutputsAreIdentical는 README가 diff로 비교하는 대로 각 예제의 Go, PHP,
// Rust 프로그램이 시드된 bench database에서 byte 단위로 같은 stdout을 내는지 확인한다.
// Rust 프로그램 경로는 EXAMPLE_RUST_COMPLEX와 EXAMPLE_RUST_DEMO가 선언한다.
func TestExampleOutputsAreIdentical(t *testing.T) {
	testcase.Group(t)
	if os.Getenv("ORM_BENCH_MYSQL_DSN") == "" {
		t.Fatal("ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run")
	}
	examples := map[string]string{"complex": "EXAMPLE_RUST_COMPLEX", "thin-slice": "EXAMPLE_RUST_DEMO"}
	for name, rustVar := range examples {
		t.Run(name, func(t *testing.T) {
			// 예제 하나는 Go program을 build하고 세 program을 한 번씩 실행한다.
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
			if !bytes.Equal(goOut, rustOut) {
				t.Errorf("%s: go and rust outputs differ\n--- go\n%s\n--- rust\n%s", name, goOut, rustOut)
			}
		})
	}
}

// runExample는 프로그램 하나를 실행해 stdout을 돌려주고 실행 시간을 기록한다.
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
