//go:build featurecoverage

package orm_test

import (
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageInterfaceSymbols는 repository root에서 Go client의 interface
// check를 실행하고 성공하는지 확인한다.
func TestCoverageInterfaceSymbols(t *testing.T) {
	testcase.Start(t, testcase.Process)
	cmd := exec.Command("node", "tests/interfaces/check/main.mts", "-language", "go")
	cmd.Dir = filepath.Join("..", "..", "..")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("interface check: %v\n%s", err, output)
	}
}
