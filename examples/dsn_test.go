// Package examples_test는 Go와 PHP 예제 프로그램이 ORM_BENCH_MYSQL_DSN 없이
// 연결하지 않고 그 변수 이름을 출력하며 실패하는지 확인한다. Rust 예제는
// clients/rust/tests/tests/example_dsn.rs가 확인한다.
package examples_test

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// withoutBenchDSN은 ORM_BENCH_MYSQL_DSN을 뺀 환경이다. empty면 빈 값으로 둔다.
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
