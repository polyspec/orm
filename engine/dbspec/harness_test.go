package dbspec

import (
	"fmt"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// repositoryRoot is the module root, found from this file's own position so
// the tests do not depend on the working directory.
func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the dbspec test source")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

// runTimed runs work under its own deadline and logs its start, its result
// and its elapsed time. work runs on its own goroutine and reports failure by
// returning an error, so the deadline is observed even when work hangs.
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
