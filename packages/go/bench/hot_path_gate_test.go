//go:build perfgate

// The hot-path gate tests are timing-sensitive, so they build only with the tag perfgate, which make perf-check
// (scripts/perf-test.mts) gives when it runs them against the seeded bench database; a go test without the tag
// does not select them.
package bench

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
	"sync/atomic"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

func TestHotPathGate(t *testing.T) {
	testcase.Start(t, gateDeadline)
	hotPathGate(t)
}

// TestHotPathGateUnderLoad runs the gate while one busy process per CPU
// runs beside it. Load slows the native and the client side of each pair
// alike, so the verdict equals the verdict without load.
func TestHotPathGateUnderLoad(t *testing.T) {
	testcase.Start(t, gateDeadline)
	var load []*exec.Cmd
	for i := 0; i < runtime.NumCPU(); i++ {
		cmd := exec.Command(os.Args[0], "-test.run=^TestCPULoad$")
		cmd.Env = append(os.Environ(), "ORM_BENCH_CPU_LOAD=1")
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		load = append(load, cmd)
	}
	defer func() {
		// Every busy process is ended even when one of them fails to end, so the errors are reported
		// one by one and not with t.Fatal, which would leave the rest running.
		for _, cmd := range load {
			if err := cmd.Process.Kill(); err != nil {
				t.Errorf("kill the CPU load process: %v", err)
			}
			// A killed process ends by a signal, which Wait reports as an ExitError with exit code -1.
			var exit *exec.ExitError
			if err := cmd.Wait(); err != nil && (!errors.As(err, &exit) || exit.ExitCode() != -1) {
				t.Errorf("wait for the CPU load process: %v", err)
			}
		}
	}()
	hotPathGate(t)
}

// TestCPULoad is the busy process of TestHotPathGateUnderLoad; it runs only
// when that test starts it with ORM_BENCH_CPU_LOAD=1 and ends when killed.
func TestCPULoad(t *testing.T) {
	if os.Getenv("ORM_BENCH_CPU_LOAD") != "1" {
		// Load is generated only in a child process that TestHotPathGateUnderLoad starts and waits for,
		// and that process runs without a deadline until the parent ends it.
		testcase.Start(t, testcase.Compute)
		return
	}
	x := uint64(1)
	for {
		x = x*6364136223846793005 + 1442695040888963407
		loadSink.Store(x)
	}
}

// loadSink keeps the busy loop's result observable.
var loadSink atomic.Uint64
