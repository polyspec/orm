//go:build featurecoverage

package orm_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// TestCoverageInterfaceSymbols는 repository root에서 Go client의 interface
// check를 실행하고 성공하는지 확인한다.
func TestCoverageInterfaceSymbols(t *testing.T) {
	cmd := exec.Command("go", "run", "./tests/interfaces/check", "-language", "go")
	cmd.Dir = filepath.Join("..", "..", "..")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("interface check: %v\n%s", err, output)
	}
}
