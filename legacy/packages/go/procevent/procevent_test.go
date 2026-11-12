package procevent

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestWatchExit checks that the wait of WatchExit returns when the process ends, that Alive reports the process
// while it runs and not after it ended, and that a process already gone gives ESRCH.
func TestWatchExit(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	// cat runs until its standard input closes, so the test decides when the process ends.
	child := exec.Command("cat")
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	pid := child.Process.Pid
	wait, err := WatchExit(pid)
	if err != nil {
		t.Fatal(errors.Join(err, stdin.Close(), child.Wait()))
	}
	if !Alive(pid) {
		t.Errorf("Alive(%d) of a running process = false", pid)
	}
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := wait(); err != nil {
		t.Fatalf("wait for the exit of %d: %v", pid, err)
	}
	if err := child.Wait(); err != nil {
		t.Fatal(err)
	}
	if Alive(pid) {
		t.Errorf("Alive(%d) of an ended process = true", pid)
	}
	if _, err := WatchExit(pid); !errors.Is(err, unix.ESRCH) {
		t.Errorf("WatchExit(%d) of an ended process = %v, want ESRCH", pid, err)
	}
}

// TestWatchDir checks that the wait of WatchDir returns when an entry of the directory is created, and that the
// watch closes.
func TestWatchDir(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	dir := t.TempDir()
	next, closeWatch, err := WatchDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "entry"), nil, 0o600); err != nil {
		t.Fatal(errors.Join(err, closeWatch()))
	}
	if err := next(); err != nil {
		t.Fatal(errors.Join(err, closeWatch()))
	}
	if err := closeWatch(); err != nil {
		t.Fatalf("close the watch: %v", err)
	}
}
