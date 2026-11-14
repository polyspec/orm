package contracts

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestPathsFromAnyDirectory runs the tests of this package that read files of the checkout with the repository root as
// their working directory instead of the package directory: they must pass there too, so they find those files at any
// depth of the working directory (T448).
func TestPathsFromAnyDirectory(t *testing.T) {
	testcase.Start(t)
	const pattern = `^(TestPythonSignatureReadsLikeTheOtherClients|TestLogicalContractRejectsNativeDrift|TestGroupedResultCannotBecomeModelCollection|TestExtensionContractRejectsDrift|TestLanguagesAreTheDeclaredImplementations)$`
	output, err := testcase.RunFrom(t, testcase.RepositoryRoot(), pattern)
	if err != nil {
		t.Fatalf("the tests %s run from the repository root: %v\n%s", pattern, err, output)
	}
	if !strings.Contains(output, "--- PASS") {
		t.Fatalf("the tests %s run from the repository root ran no test\n%s", pattern, output)
	}
}
