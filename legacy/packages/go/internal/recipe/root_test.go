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

// TestLegacyRecipeFixtureIsTheLegacyCopy checks that a legacy recipe installs the fixture set of legacy/contracts, the
// copy that the generated legacy models come from, and not the set of the same name under the repository root, which
// its $schema reaches (T640).
func TestLegacyRecipeFixtureIsTheLegacyCopy(t *testing.T) {
	testcase.Start(t)
	path := testcase.LegacyPath("contracts/fixtures/composite_keys/composite_keys.json")
	f := readRecipe[databaseFile](t, path)
	got, err := fixturePath(path, f)
	if err != nil {
		t.Fatal(err)
	}
	if want := testcase.LegacyPath(f.Fixture); got != want {
		t.Fatalf("the fixture of %s is %s, want %s", path, got, want)
	}
}
