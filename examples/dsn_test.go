// Package examples_test checks that the Go and PHP example programs, without ORM_BENCH_MYSQL_DSN,
// do not connect, and fail while printing that variable name. The Rust example
// is checked by packages/rust/tests/tests/example_dsn.rs.
package examples_test

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// withoutBenchDSN is the environment without ORM_BENCH_MYSQL_DSN. If empty, it is set to an empty value.
// pythonThinSlice is the Python client example of the thin slice; it lives in the Python package, relative to this directory.
var pythonThinSlice = filepath.Join("..", "packages", "python", "examples", "thin_slice", "main.py")

func withoutBenchDSN(empty bool) []string {
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "ORM_BENCH_MYSQL_DSN=") {
			env = append(env, kv)
		}
	}
	if empty {
		env = append(env, "ORM_BENCH_MYSQL_DSN=")
	}
	return env
}

func TestExamplesRequireBenchDSN(t *testing.T) {
	testcase.Start(t, testcase.Process)
	programs := map[string][]string{}
	for _, name := range []string{"complex", "thin-slice"} {
		bin := filepath.Join(t.TempDir(), name)
		if out, err := exec.Command("go", "build", "-o", bin, "./"+name+"/go").CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v\n%s", name, err, out)
		}
		programs["go/"+name] = []string{bin}
		programs["php/"+name] = []string{"php", filepath.Join(name, "php", "main.php")}
		if name == "thin-slice" {
			programs["ts/"+name] = []string{"node", filepath.Join(name, "ts", "main.mts")}
			programs["python/"+name] = []string{"python3", pythonThinSlice}
		}
	}
	for name, args := range programs {
		for _, empty := range []bool{false, true} {
			state := "unset"
			if empty {
				state = "empty"
			}
			t.Run(name+"/"+state, func(t *testing.T) {
				var stderr bytes.Buffer
				cmd := exec.Command(args[0], args[1:]...)
				cmd.Env = withoutBenchDSN(empty)
				cmd.Stderr = &stderr
				err := cmd.Run()
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.ExitCode() != 1 {
					t.Fatalf("want exit status 1 without ORM_BENCH_MYSQL_DSN, got %v; stderr: %s", err, stderr.String())
				}
				if !strings.Contains(stderr.String(), "ORM_BENCH_MYSQL_DSN is required") {
					t.Fatalf("stderr lacks the DSN requirement: %s", stderr.String())
				}
			})
		}
	}
}
