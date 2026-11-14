package engine

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestPathsFromAnyDirectory runs the tests of this package that read files of the checkout with the repository root as
// their working directory instead of the package directory: they must pass there too, so they find those files at any
// depth of the working directory (T448).
func TestPathsFromAnyDirectory(t *testing.T) {
	testcase.Start(t)
	const pattern = `^(TestSelectAll|TestLoad)$`
	testcase.PassFromRoot(t, pattern)
}
