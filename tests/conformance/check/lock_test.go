package main

import (
	"bufio"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// TestLockHelper는 다른 process로 실행되어 lock을 잡는 helper다. ORM_LOCK_HELPER가 dsn이면 그 lock을 잡고, ORM_LOCK_HOLD가
// 있으면 stdin이 닫힐 때까지 기다리며, 없으면 놓지 않고 곧바로 끝난다(kill된 실행처럼).
func TestLockHelper(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	dsn := os.Getenv("ORM_LOCK_HELPER")
	if dsn == "" {
		t.Skip("run by TestLockOfAnEndedRunDoesNotHold")
	}
	if err := lockDatabases(dsn); err != nil {
		os.Stdout.WriteString("refused: " + err.Error() + "\n")
		os.Exit(3)
	}
	os.Stdout.WriteString("locked\n")
	if os.Getenv("ORM_LOCK_HOLD") != "" {
		buffer := make([]byte, 1)
		os.Stdin.Read(buffer)
	}
	os.Exit(0)
}

// TestLockOfAnEndedRunDoesNotHold는 lock을 놓지 않고 끝난 process의 lock이 다음 실행을 막지 않고, 살아 있는
// process의 lock은 그 pid와 함께 막는지 본다.
func TestLockOfAnEndedRunDoesNotHold(t *testing.T) {
	testcase.Start(t, testcase.Process)
	t.Setenv("TMPDIR", t.TempDir())
	dsn := "mysql://root@127.0.0.1:1/orm_lock_test_" + strings.ReplaceAll(t.Name(), "/", "_")
	helper := func(hold bool) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestLockHelper$")
		cmd.Env = append(os.Environ(), "ORM_LOCK_HELPER="+dsn)
		if hold {
			cmd.Env = append(cmd.Env, "ORM_LOCK_HOLD=1")
		}
		return cmd
	}
	defer os.RemoveAll(lockPath(dsn))
	if output, err := helper(false).CombinedOutput(); err != nil || !strings.Contains(string(output), "locked") {
		t.Fatalf("the first run did not lock: %v\n%s", err, output)
	}
	if err := lockDatabases(dsn); err != nil {
		t.Fatalf("the lock of a run that ended without releasing it still holds: %v", err)
	}
	if err := releaseLocks(); err != nil {
		t.Fatal(err)
	}

	holder := helper(true)
	stdin, err := holder.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := holder.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	lines := bufio.NewScanner(stdout)
	for lines.Scan() && lines.Text() != "locked" {
	}
	if lines.Text() != "locked" {
		t.Fatalf("the holder did not lock: %v", lines.Err())
	}
	err = lockDatabases(dsn)
	stdin.Close()
	holder.Wait()
	if err == nil || !strings.Contains(err.Error(), "another conformance run") {
		t.Fatalf("a running holder's lock did not hold: %v", err)
	}
	if want := "pid " + strconv.Itoa(holder.Process.Pid); !strings.Contains(err.Error(), want) {
		t.Fatalf("the refusal %q does not name the holder (%s)", err, want)
	}
}
