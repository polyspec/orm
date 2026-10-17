package testcase

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"
)

// fixtureVariable은 아래 fixture test를 실행하게 하는 환경 변수다. TestReportForm만 이
// 변수를 주고 하위 process로 실행한다.
const fixtureVariable = "TESTCASE_FIXTURE"

func fixture(t *testing.T, name string) {
	if os.Getenv(fixtureVariable) != name {
		t.Skipf("runs only as the child process of TestReportForm (%s=%s)", fixtureVariable, name)
	}
}

func TestFixturePass(t *testing.T) {
	fixture(t, "report")
	c := Start(t, Compute)
	c.Step("first step of %d", 2)
	// Of는 case를 시작하지 않은 subtest에서 그 subtest를 감싼 case를 찾는다.
	t.Run("inner", func(t *testing.T) { Of(t).Step("step of the enclosing case") })
}

func TestFixtureFail(t *testing.T) {
	fixture(t, "report")
	Start(t, Compute)
	t.Error("fixture failure reason")
}

func TestFixtureSkip(t *testing.T) {
	fixture(t, "report")
	Start(t, Compute)
	t.Skip("fixture skip reason")
}

func TestFixtureGroup(t *testing.T) {
	fixture(t, "report")
	Group(t)
	for _, name := range []string{"one", "two"} {
		t.Run(name, func(t *testing.T) { Start(t, Database) })
	}
}

// TestFixtureRun은 test가 아닌 runner의 Run이 통과, 실패, 기한 초과를 돌려주는 모습이다. 단계는 stdout의 줄이다.
func TestFixtureRun(t *testing.T) {
	fixture(t, "report")
	if err := Run("runner/pass", time.Minute, func(c *Case) error {
		c.Step("built %s", "runner")
		w := c.StepWriter()
		fmt.Fprint(w, "child line one\n\nchild ")
		fmt.Fprint(w, "line two\nchild tail")
		w.Flush()
		return nil
	}); err != nil {
		t.Errorf("runner/pass: %v", err)
	}
	if err := Run("runner/fail", time.Minute, func(*Case) error { return errors.New("runner failure reason") }); err == nil {
		t.Error("runner/fail returned no error")
	}
	if err := Run("runner/context", 100*time.Millisecond, func(c *Case) error {
		<-c.Context().Done()
		return c.Context().Err()
	}); err == nil {
		t.Error("runner/context returned no error")
	}
	// 느리지만 정상인 장기 작업은 기한 없이 끝까지 실행한다.
	if err := RunLong("runner/long", func(c *Case) error {
		c.Step("building")
		time.Sleep(1500 * time.Millisecond)
		c.Step("exit 0")
		return nil
	}); err != nil {
		t.Errorf("runner/long: %v", err)
	}
	if err := RunLong("runner/long-fail", func(*Case) error { return errors.New("build exited with 3") }); err == nil {
		t.Error("runner/long-fail returned no error")
	}
	if err := Run("runner/stuck", 100*time.Millisecond, func(*Case) error {
		time.Sleep(time.Minute)
		return nil
	}); err == nil {
		t.Error("runner/stuck returned no error")
	}
}

func TestFixtureDeadline(t *testing.T) {
	fixture(t, "deadline")
	Start(t, 200*time.Millisecond)
	time.Sleep(time.Minute)
}

// runFixture는 fixture test를 하위 `go test -v`로 실행하고 출력과 종료 error를 돌려준다.
func runFixture(name string) (string, error) {
	command := exec.Command("go", "test", "-run", "^TestFixture", "-count=1", "-v", ".")
	command.Env = append(os.Environ(), fixtureVariable+"="+name)
	output, err := command.CombinedOutput()
	return string(output), err
}

// inOrder는 output에 patterns가 이 순서로 한 줄씩 나타나는지 확인한다.
func inOrder(output string, patterns ...string) error {
	lines := strings.Split(output, "\n")
	at := 0
	for _, pattern := range patterns {
		re := regexp.MustCompile("^" + pattern + "$")
		found := false
		for at < len(lines) {
			line := strings.TrimSpace(lines[at])
			at++
			if re.MatchString(line) {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("no line matching %q in order", pattern)
		}
	}
	return nil
}

// TestReportForm은 Start로 시작한 case의 단계가 t.Log로, 결과가 go test의 `--- PASS`, `--- FAIL`, `--- SKIP`으로
// 나오고, 묶음과 runner의 단계와 결과도 native 출력으로 나오며, 기한이 지난 case가 진단과 함께 process를 끝내는지
// 확인한다.
func TestReportForm(t *testing.T) {
	Start(t, Process)
	output, err := runFixture("report")
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("report fixture: want a failing exit for TestFixtureFail, got %v\n%s", err, output)
	}
	checks := [][]string{
		{`=== RUN   TestFixturePass`, `.*first step of 2`, `.*step of the enclosing case`, `--- PASS: TestFixturePass \(\S+\)`},
		{`=== RUN   TestFixtureFail`, `.*fixture failure reason`, `--- FAIL: TestFixtureFail \(\S+\)`},
		{`=== RUN   TestFixtureSkip`, `.*fixture skip reason`, `--- SKIP: TestFixtureSkip \(\S+\)`},
		{`=== RUN   TestFixtureGroup/one`, `=== RUN   TestFixtureGroup/two`, `--- PASS: TestFixtureGroup \(\S+\)`,
			`--- PASS: TestFixtureGroup/one \(\S+\)`, `--- PASS: TestFixtureGroup/two \(\S+\)`},
		{`built runner`, `child line one`, `child line two`, `child tail`},
		{`building`, `exit 0`},
	}
	for _, patterns := range checks {
		if err := inOrder(output, patterns...); err != nil {
			t.Errorf("%v\n%s", err, output)
		}
	}
	if regexp.MustCompile(`(?m)\.go:\d+: *$`).MatchString(output) {
		t.Errorf("empty log line from the StepWriter\n%s", output)
	}
	output, err = runFixture("deadline")
	if !errors.As(err, &exit) {
		t.Fatalf("deadline fixture: want a failing exit, got %v\n%s", err, output)
	}
	if err := inOrder(output, `testcase TestFixtureDeadline: deadline 200ms exceeded and the case did not stop`, `goroutine [0-9]+ \[.*\]:`); err != nil {
		t.Errorf("%v\n%s", err, output)
	}
	if strings.Contains(output, "--- PASS: TestFixtureDeadline") {
		t.Errorf("PASS result for the expired case\n%s", output)
	}
}
