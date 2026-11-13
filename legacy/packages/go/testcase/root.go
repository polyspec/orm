package testcase

import (
	"os"
	"path/filepath"
)

// RepositoryRoot returns the absolute root of the checkout: the nearest directory, from the working directory of the
// test upward, that holds go.work, the tracked workspace file of the Go modules, which only the repository root holds.
// go test runs a package in its own directory, so a test finds the root at any depth of the package. A missing go.work
// panics, since the tests that read the root cannot run without it.
func RepositoryRoot() string {
	directory, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(directory, "go.work")); err == nil {
			return directory
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			panic("no directory above the working directory holds go.work")
		}
		directory = parent
	}
}

// LegacyRoot returns the legacy directory of the checkout, which holds the language implementations and the fixtures
// and vectors that they read.
func LegacyRoot() string {
	return filepath.Join(RepositoryRoot(), "legacy")
}
