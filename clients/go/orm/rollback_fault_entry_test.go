package orm_test

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// TestRollbackFaultEntry는 FailNextRollback이 build tag ormtest가 있는 build에만
// 있는지 확인한다: tag가 없으면 package가 그 file을 제외하고, tag가 있으면
// compile한다.
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
