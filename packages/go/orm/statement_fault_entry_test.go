package orm_test

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestStatementFaultEntry는 FailNextStatement이 build tag ormtest가 있는 build에만
// 있는지 확인한다. FailNextStatement은 fault_ormtest.go에 있으므로 그 file이 tag가
// 없는 build에서 제외되고 tag가 있는 build에 포함되어야 한다.
func TestStatementFaultEntry(t *testing.T) {
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
