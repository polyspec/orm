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
