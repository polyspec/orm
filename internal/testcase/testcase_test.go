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

// TestFixtureRun은 test가 아닌 runner의 Run이 통과, 실패, 기한 초과를 보고하는 모습이다.
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

const elapsed = `elapsed=[0-9.]+(ns|µs|ms|s|m[0-9.]+s)`

// TestReportForm은 Start, Step, Group, Run이 case마다 시작, 단계, 결과와 경과 시간을 이 순서로
// 출력하고, 기한이 지난 case를 FAIL로 보고하고 process를 끝내는지 확인한다.
func TestReportForm(t *testing.T) {
	Start(t, Process)
	output, err := runFixture("report")
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("report fixture: want a failing exit for TestFixtureFail, got %v\n%s", err, output)
	}
	checks := [][]string{
		{`RUN TestFixturePass deadline=1m0s`, `STEP TestFixturePass ` + elapsed + `: first step of 2`, `PASS TestFixturePass ` + elapsed},
		{`RUN TestFixtureFail deadline=1m0s`, `.*fixture failure reason`, `FAIL TestFixtureFail ` + elapsed + `: the errors reported above`},
		{`RUN TestFixtureSkip deadline=1m0s`, `SKIP TestFixtureSkip ` + elapsed},
		{`RUN TestFixtureGroup group`, `RUN TestFixtureGroup/one deadline=2m0s`, `PASS TestFixtureGroup/one ` + elapsed,
			`RUN TestFixtureGroup/two deadline=2m0s`, `PASS TestFixtureGroup/two ` + elapsed, `PASS TestFixtureGroup ` + elapsed},
		{`RUN runner/pass deadline=1m0s`, `STEP runner/pass ` + elapsed + `: built runner`, `STEP runner/pass ` + elapsed + `: child line one`,
			`STEP runner/pass ` + elapsed + `: child line two`, `STEP runner/pass ` + elapsed + `: child tail`, `PASS runner/pass ` + elapsed},
		{`RUN runner/fail deadline=1m0s`, `FAIL runner/fail ` + elapsed + `: runner failure reason`},
		{`RUN runner/context deadline=100ms`, `FAIL runner/context ` + elapsed + `: context deadline exceeded`},
		{`RUN runner/stuck deadline=100ms`, `FAIL runner/stuck ` + elapsed + `: deadline 100ms exceeded`},
	}
	for _, patterns := range checks {
		if err := inOrder(output, patterns...); err != nil {
			t.Errorf("%v\n%s", err, output)
		}
	}
	output, err = runFixture("deadline")
	if !errors.As(err, &exit) {
		t.Fatalf("deadline fixture: want a failing exit, got %v\n%s", err, output)
	}
	if err := inOrder(output, `RUN TestFixtureDeadline deadline=200ms`, `FAIL TestFixtureDeadline `+elapsed+`: deadline 200ms exceeded`, `goroutine [0-9]+ \[.*\]:`); err != nil {
		t.Errorf("%v\n%s", err, output)
	}
	if regexp.MustCompile(`STEP runner/pass `+elapsed+`: \n`).MatchString(output) {
		t.Errorf("empty STEP line from the StepWriter\n%s", output)
	}
	if strings.Contains(output, "PASS TestFixtureDeadline") {
		t.Errorf("PASS line for the expired case\n%s", output)
	}
}
