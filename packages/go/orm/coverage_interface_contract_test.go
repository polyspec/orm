package orm_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

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
	// The line the feature checker reads (FCV-12); a run outside the checker names no file.
	if path := os.Getenv("ORM_RECIPE_RESULTS"); path != "" {
		if err := os.WriteFile(path, []byte("CASE interface_symbols PASS\n"), 0o600); err != nil {
			t.Fatalf("results: %v", err)
		}
	}
}
