package testcase

import (
	"fmt"
	"os"
	"path/filepath"
)

// RepositoryRoot returns the absolute root of the checkout: the nearest directory, from the working directory of the
// test upward, that holds go.work and no go.mod. The go.work of the repository root is the workspace file of the Go
// modules below it, and the root is not itself a module; a go.work beside a go.mod is the workspace of that one module,
// as a link tool writes it there, so it is passed over and the search continues upward. go test runs a package in its
// own directory, so a test finds the root at any depth of the package. A checkout without such a directory panics,
// since the tests that read the root cannot run without it.
func RepositoryRoot() string {
	directory, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	root, err := repositoryRootFrom(directory)
	if err != nil {
		panic(err)
	}
	return root
}

// repositoryRootFrom returns the root of the checkout that holds the directory start, by the rule of RepositoryRoot.
func repositoryRootFrom(start string) (string, error) {
	for directory := start; ; {
		if holdsFile(directory, "go.work") && !holdsFile(directory, "go.mod") {
			return directory, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", fmt.Errorf("no directory from %s upward holds go.work without go.mod", start)
		}
		directory = parent
	}
}

// holdsFile reports whether the directory holds a file of the name.
func holdsFile(directory, name string) bool {
	info, err := os.Stat(filepath.Join(directory, name))
	return err == nil && !info.IsDir()
}

// LegacyRoot returns the legacy directory of the checkout, which holds the language implementations and the fixtures
// and vectors that they read.
func LegacyRoot() string {
	return filepath.Join(RepositoryRoot(), "legacy")
}

// RepositoryPath returns the absolute path of the slash-separated path relative under the repository root.
func RepositoryPath(relative string) string {
	return filepath.Join(RepositoryRoot(), filepath.FromSlash(relative))
}

// LegacyPath returns the absolute path of the slash-separated path relative under the legacy directory.
func LegacyPath(relative string) string {
	return filepath.Join(LegacyRoot(), filepath.FromSlash(relative))
}
