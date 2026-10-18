package orm_test

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRollbackFaultEntry checks that FailNextRollback is present only in builds with the ormtest build tag:
// without the tag the package excludes this file, and with the tag it
// compiles.
func TestRollbackFaultEntry(t *testing.T) {
	testcase.Start(t, testcase.Process)
	list := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("go", append([]string{"list"}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("go list %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	const format = "{{.GoFiles}} {{.IgnoredGoFiles}}"
	plain := list("-f", format, ".")
	tagged := list("-tags", "ormtest", "-f", format, ".")
	plainFiles, plainIgnored, _ := strings.Cut(plain, "] [")
	taggedFiles, _, _ := strings.Cut(tagged, "] [")
	if strings.Contains(plainFiles, "fault_ormtest.go") || !strings.Contains(plainIgnored, "fault_ormtest.go") {
		t.Fatalf("a build without the tag ormtest lists %s", plain)
	}
	if !strings.Contains(taggedFiles, "fault_ormtest.go") {
		t.Fatalf("a build with the tag ormtest lists %s", tagged)
	}
}
