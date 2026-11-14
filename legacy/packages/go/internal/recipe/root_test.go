package recipe

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestInterfaceCheckRunsFromTheRepositoryRoot checks that the interface check of an interface.symbols step starts at the
// repository root, where tests/interfaces/check/main.mts is, whatever the working directory and the directory of the
// recipe are (T448).
func TestInterfaceCheckRunsFromTheRepositoryRoot(t *testing.T) {
	testcase.Start(t)
	root := testcase.RepositoryRoot()
	t.Chdir(testcase.LegacyRoot())
	command := interfaceCheckCommand(context.Background())
	if command.Dir != root {
		t.Fatalf("the interface check runs in %q, want the repository root %q", command.Dir, root)
	}
	if _, err := os.Stat(filepath.Join(command.Dir, command.Args[1])); err != nil {
		t.Fatalf("the interface check script is not at the directory it runs in: %v", err)
	}
}
