package testcase

import (
	"os"
	"path/filepath"
	"testing"
)

// TestRepositoryRoot checks that RepositoryRoot finds, from the directory of this package, the directory that holds
// go.work, contracts/implementations.json and docs/spec, and that it is an absolute path (T447).
func TestRepositoryRoot(t *testing.T) {
	Start(t)
	root := RepositoryRoot()
	if !filepath.IsAbs(root) {
		t.Fatalf("RepositoryRoot returned %q, which is not absolute", root)
	}
	for _, name := range []string{"go.work", filepath.Join("contracts", "implementations.json"), filepath.Join("docs", "spec")} {
		if _, err := os.Stat(filepath.Join(root, name)); err != nil {
			t.Errorf("the repository root %s does not hold %s: %v", root, name, err)
		}
	}
	if legacy := filepath.Join(root, "legacy"); LegacyRoot() != legacy {
		t.Errorf("LegacyRoot returned %q, want %q", LegacyRoot(), legacy)
	}
}

// rootWorkspace is the go.work of the repository root as the repository tracks it: it uses modules below the root, and
// no go.mod is beside it.
const rootWorkspace = "go 1.27.3\n\nuse (\n\t./examples\n\t./legacy/packages/go\n\t./tests\n)\n"

// linkedWorkspace is the go.work that kit link writes in the module legacy/packages/go, beside its go.mod, as go work
// init writes it: it uses the module itself, a provider outside the checkout and the other modules of the root.
const linkedWorkspace = "go 1.27.3\n\nuse (\n\t.\n\t../../../../links/json-cases/packages/go\n\t../../../examples\n\t../../../tests\n)\n"

// writeTree writes the files, slash-separated paths with their contents, under a new temporary directory, and returns
// that directory.
func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	top := t.TempDir()
	for name, content := range files {
		file := filepath.Join(top, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return top
}

// expectRoot checks that the root found from the slash-separated directory start under top is the slash-separated
// directory want under top.
func expectRoot(t *testing.T, top, start, want string) {
	t.Helper()
	root, err := repositoryRootFrom(filepath.Join(top, filepath.FromSlash(start)))
	if err != nil {
		t.Fatalf("repositoryRootFrom(%s) failed: %v", start, err)
	}
	if expected := filepath.Join(top, filepath.FromSlash(want)); root != expected {
		t.Fatalf("repositoryRootFrom(%s) returned %q, want %q", start, root, expected)
	}
}

// TestRepositoryRootPlainCheckout checks that, in a checkout whose only go.work is that of the root, the root is found
// from a package of a module below it (T566).
func TestRepositoryRootPlainCheckout(t *testing.T) {
	Start(t)
	top := writeTree(t, map[string]string{
		"repo/go.work":                             rootWorkspace,
		"repo/legacy/packages/go/go.mod":           "module example.test/orm\n\ngo 1.27.3\n",
		"repo/legacy/packages/go/testcase/root.go": "package testcase\n",
	})
	expectRoot(t, top, "repo/legacy/packages/go/testcase", "repo")
	expectRoot(t, top, "repo", "repo")
}

// TestRepositoryRootPassesOverLinkedModuleWorkspace checks that the go.work that kit link writes in a module, beside
// its go.mod, is passed over, and that the root above it, whose go.work has no go.mod beside it, is found (T566).
func TestRepositoryRootPassesOverLinkedModuleWorkspace(t *testing.T) {
	Start(t)
	top := writeTree(t, map[string]string{
		"repo/go.work":                             rootWorkspace,
		"repo/legacy/packages/go/go.mod":           "module example.test/orm\n\ngo 1.27.3\n",
		"repo/legacy/packages/go/go.work":          linkedWorkspace,
		"repo/legacy/packages/go/testcase/root.go": "package testcase\n",
	})
	expectRoot(t, top, "repo/legacy/packages/go/testcase", "repo")
	expectRoot(t, top, "repo/legacy/packages/go", "repo")
}

// TestRepositoryRootKnownLimitRootThatIsAModuleIsPassedOver fixes the limit of the rule: a repository root that holds
// go.mod beside its go.work is itself passed over, so the finder returns the next directory above it that holds go.work
// without go.mod, here the directory outer, and not the root. The repository root must therefore never be a Go module
// (T566).
func TestRepositoryRootKnownLimitRootThatIsAModuleIsPassedOver(t *testing.T) {
	Start(t)
	top := writeTree(t, map[string]string{
		"outer/go.work":           "go 1.27.3\n\nuse ./repo\n",
		"outer/repo/go.mod":       "module example.test/repo\n\ngo 1.27.3\n",
		"outer/repo/go.work":      "go 1.27.3\n\nuse .\n",
		"outer/repo/pkg/thing.go": "package pkg\n",
	})
	expectRoot(t, top, "outer/repo/pkg", "outer")
	expectRoot(t, top, "outer/repo", "outer")
}
