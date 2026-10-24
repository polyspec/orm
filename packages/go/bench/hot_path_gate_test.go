//go:build perfgate

// The hot-path gate tests are timing-sensitive, so they build only with the tag perfgate, which make perf-check
// (scripts/perf-test.mts) gives when it runs them against the seeded bench database; a go test without the tag
// does not select them.
package bench

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sync/atomic"
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
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

// hotPathGate measures every workload and warns when a ratio exceeds its bound; a measurement never fails t.
func hotPathGate(t *testing.T) {
	t.Helper()
	sqlDB := open(t)
	ctx := context.Background()
	db, err := model.Connect(dsn(t), orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)

	for _, c := range []struct {
		name           string
		native, client func()
		bound          float64
	}{
		{
			name:   "pk",
			native: func() { mustNoErr(t, func() error { _, err := pkGet(ctx, sqlDB, 42); return err }) },
			client: func() {
				mustNoErr(t, func() error { _, err := model.Author().Connect(db).GetBySeq(42); return err })
			},
			bound: pkBound,
		},
		{
			name:   "list100",
			native: func() { mustNoErr(t, func() error { _, err := list100(ctx, sqlDB, 7); return err }) },
			client: func() {
				mustNoErr(t, func() error {
					_, err := model.Author().Connect(db).ServiceSeq(7).AndIsClose(false).OrderBySeqDesc().Limit(0, 100).Gets()
					return err
				})
			},
			bound: listBound,
		},
	} {
		na, cl, ratio := pairedRatio(t, c.native, c.client)
		fmt.Printf("%-8s native %6.1fµs  client %6.1fµs  ratio %.2f (bound %.2f)\n",
			c.name, float64(na.Microseconds()), float64(cl.Microseconds()), ratio, c.bound)
		if ratio > c.bound {
			testcase.Warn("%s: client/native ratio %.2f is above its reference %.2f (docs/operations/perf.md)", c.name, ratio, c.bound)
		}
	}
}

func mustNoErr(tb testing.TB, f func() error) {
	tb.Helper()
	if err := f(); err != nil {
		tb.Fatal(err)
	}
}
