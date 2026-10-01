package dbspec

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// repositoryRoot는 이 file의 위치로 찾은 module root이므로 test는 working directory에
// 기대지 않는다.
func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the dbspec test source")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

// runTimed는 work를 자기 deadline 아래에서 실행하고 시작, 결과, 경과 시간을 기록한다. work는
// 자기 goroutine에서 실행되며 error를 돌려 실패를 알리므로, work가 멈춰도 deadline을 지킨다.
func runTimed(t *testing.T, name string, deadline time.Duration, work func() error) {
	t.Helper()
	started := time.Now()
	t.Logf("RUN %s deadline=%s", name, deadline)
	done := make(chan error, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- fmt.Errorf("panic: %v", recovered)
			}
		}()
		done <- work()
	}()
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	select {
	case err := <-done:
		elapsed := time.Since(started)
		if err != nil {
			t.Errorf("FAIL %s elapsed=%s: %v", name, elapsed, err)
			return
		}
		t.Logf("PASS %s elapsed=%s", name, elapsed)
	case <-timer.C:
		t.Fatalf("FAIL %s: deadline %s exceeded", name, deadline)
	}
}

// failingCaseFixture는 TestFailingCaseFixture를 실행하게 하는 환경 변수다.
// TestCaseHarnessReportsOnlyFailure만 이 변수를 주고 하위 process로 실행한다.
const failingCaseFixture = "DBSPEC_FAILING_CASE_FIXTURE"

// failingCaseNames는 TestFailingCaseFixture가 틀린 기대값으로 실행하는 case의 이름이다.
func failingCaseNames(t *testing.T) []string {
	t.Helper()
	m := loadMermaidVectors(t)
	p := loadPlanVectors(t)
	return []string{
		"mermaid/export/" + m.Export[0].ID,
		"mermaid/import/" + m.Import[0].ID,
		"mermaid/invalid/" + m.Invalid[0].ID,
		"mermaid/round_trip/" + m.RoundTrip[0].ID,
		"plan/" + p.Cases[0].ID,
		"plan/invalid/" + p.Invalid[0].ID,
		"plan/chain/" + p.Chains[0].ID,
		"plan/parse/" + p.Parse[0].ID,
		"plan/comparison/" + p.Comparisons[1].ID,
	}
}

// TestFailingCaseFixture는 각 case 검사를 기대값 하나만 틀린 vector로 실행한다.
// 모든 case가 실패해야 하므로 failingCaseFixture가 없으면 건너뛴다.
func TestFailingCaseFixture(t *testing.T) {
	if os.Getenv(failingCaseFixture) != "1" {
		t.Skipf("runs only as the child process of TestCaseHarnessReportsOnlyFailure (%s=1)", failingCaseFixture)
	}
	m := loadMermaidVectors(t)
	p := loadPlanVectors(t)
	export := m.Export[0]
	export.Mermaid = append(slices.Clone(export.Mermaid), "%% wrong")
	imported := m.Import[0]
	imported.Document = append(slices.Clone(imported.Document), "wrong")
	invalid := m.Invalid[0]
	invalid.Errors = nil
	roundTrip := m.RoundTrip[0]
	roundTrip.Dropped = nil
	planCase := p.Cases[0]
	planCase.Changes = nil
	planInvalid := p.Invalid[0]
	planInvalid.Errors = nil
	chain := p.Chains[0]
	chain.Order = []string{"wrong"}
	parse := p.Parse[0]
	parse.Errors = nil
	// 첫 comparison은 차이가 없으므로 차이가 있는 둘째 case를 비운다.
	comparison := p.Comparisons[1]
	comparison.Differences = nil
	t.Run("export", func(t *testing.T) { checkMermaidExport(t, export) })
	t.Run("import", func(t *testing.T) { checkMermaidImport(t, imported) })
	t.Run("invalid", func(t *testing.T) { checkMermaidInvalid(t, invalid) })
	t.Run("round_trip", func(t *testing.T) { checkMermaidRoundTrip(t, roundTrip) })
	t.Run("plan", func(t *testing.T) { checkPlanCase(t, planCase) })
	t.Run("plan_invalid", func(t *testing.T) { checkPlanInvalid(t, planInvalid) })
	t.Run("chain", func(t *testing.T) { checkPlanChain(t, chain) })
	t.Run("parse", func(t *testing.T) { checkPlanParse(t, parse) })
	t.Run("comparison", func(t *testing.T) { checkComparison(t, comparison) })
}

// TestCaseHarnessReportsOnlyFailure는 실패한 case가 FAIL 줄만 출력하고 PASS 줄은
// 출력하지 않는지 TestFailingCaseFixture를 하위 process로 실행해 확인한다.
func TestCaseHarnessReportsOnlyFailure(t *testing.T) {
	names := failingCaseNames(t)
	runTimed(t, "harness/only-failure", 2*time.Minute, func() error {
		command := exec.Command("go", "test", "-run", "^TestFailingCaseFixture$", "-count=1", "-v", ".")
		command.Env = append(os.Environ(), failingCaseFixture+"=1")
		output, err := command.CombinedOutput()
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return fmt.Errorf("fixture run: want a failing exit, got %v\n%s", err, output)
		}
		var problems []error
		for _, name := range names {
			if !strings.Contains(string(output), "FAIL "+name+" ") {
				problems = append(problems, fmt.Errorf("no FAIL line for %s", name))
			}
			if strings.Contains(string(output), "PASS "+name+" ") || strings.Contains(string(output), "PASS "+name+"\n") {
				problems = append(problems, fmt.Errorf("PASS line for the failing case %s", name))
			}
		}
		if len(problems) > 0 {
			return fmt.Errorf("%w\n%s", errors.Join(problems...), output)
		}
		return nil
	})
}
