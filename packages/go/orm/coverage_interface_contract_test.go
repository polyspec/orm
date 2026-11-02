//go:build featurecoverage

package orm_test

import (
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Rule: R6 (config/parity.json binds this test under the roots of packages/go; the check runs from it as the
// ledger requires, see the CHANGELOG line of T334-3-24).
// TestCoverageInterfaceSymbols runs the Go client's interface
// check from the repository root and checks that it succeeds.
// Requirements: INT-17, INT-18, INT-19, INT-57, INT-61, INT-64.
func TestCoverageInterfaceSymbols(t *testing.T) {
	testcase.Start(t, testcase.Process)
	cmd := exec.Command("node", "tests/interfaces/check/main.mts", "-language", "go")
	cmd.Dir = filepath.Join("..", "..", "..")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("interface check: %v\n%s", err, output)
	}
}
