package orm_test

import (
	"os/exec"
	"strings"
	"testing"
)

// TestRollbackFaultEntry checks that FailNextRollback exists only in a build
// with the tag ormtest: without the tag the package excludes its file, and
// with the tag the package compiles it.
func TestRollbackFaultEntry(t *testing.T) {
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
