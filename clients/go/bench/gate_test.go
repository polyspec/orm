// The hot-path regression gate compares the generated client with this
// package's native statements (same SQL, same typed scan), in one
// process, so the ratio is comparable on any machine. docs/perf.md §6d records
// the absolute numbers; this test warns when a client drifts past the bound, and never fails on it (AGENTS.md).
//
//	make perf-check
package bench

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

// The ratio is comparable across machines. A Unix socket emphasizes fixed
// client cost; a TCP connection emphasizes database round-trip cost. The limits
// detect a client cost greater than one third of the equivalent native query.
const (
	pkBound   = 1.35
	listBound = 1.25
	gateWarm  = 100
	gatePairs = 1000
)

// gateDeadline은 hot-path gate case의 기한이다. 각 workload는 gateWarm+gatePairs 쌍의
// native와 client 호출을 bench database에 보내고, 부하 process가 모든 CPU를 쓰는 동안에도
// 몇십 초 안에 끝나므로 5분은 멈춘 case만 끝낸다.
const gateDeadline = 5 * time.Minute

// pairedRatio measures native and client in adjacent pairs, alternating which
// side runs first, and returns the median native and client times and the
// median of the per-pair client/native ratios. Load that slows one pair slows
// both of its sides, so the median ratio does not follow the machine load.
func pairedRatio(tb testing.TB, native, client func()) (time.Duration, time.Duration, float64) {
	tb.Helper()
	for i := 0; i < gateWarm; i++ {
		native()
		client()
	}
	n := make([]time.Duration, gatePairs)
	c := make([]time.Duration, gatePairs)
	ratios := make([]float64, gatePairs)
	timed := func(f func()) time.Duration {
		start := time.Now()
		f()
		return time.Since(start)
	}
	for i := range n {
		if i%2 == 0 {
			n[i] = timed(native)
			c[i] = timed(client)
		} else {
			c[i] = timed(client)
			n[i] = timed(native)
		}
		ratios[i] = float64(c[i]) / float64(n[i])
	}
	sort.Slice(n, func(i, j int) bool { return n[i] < n[j] })
	sort.Slice(c, func(i, j int) bool { return c[i] < c[j] })
	sort.Float64s(ratios)
	return n[len(n)/2], c[len(c)/2], ratios[len(ratios)/2]
}

func TestHotPathGate(t *testing.T) {
	testcase.Start(t, gateDeadline)
	if os.Getenv("ORM_RUN_PERF_GATE") != "1" {
		t.Skip("set ORM_RUN_PERF_GATE=1 to run the timing-sensitive regression check")
	}
	hotPathGate(t)
}

// TestHotPathGateUnderLoad runs the gate while one busy process per CPU
// runs beside it. Load slows the native and the client side of each pair
// alike, so the verdict equals the verdict without load.
func TestHotPathGateUnderLoad(t *testing.T) {
	testcase.Start(t, gateDeadline)
	if os.Getenv("ORM_RUN_PERF_GATE") != "1" {
		t.Skip("set ORM_RUN_PERF_GATE=1 to run the timing-sensitive regression check")
	}
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
		for _, cmd := range load {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	hotPathGate(t)
}

// TestCPULoad is the busy process of TestHotPathGateUnderLoad; it runs only
// when that test starts it with ORM_BENCH_CPU_LOAD=1 and ends when killed.
func TestCPULoad(t *testing.T) {
	if os.Getenv("ORM_BENCH_CPU_LOAD") != "1" {
		// 부하를 만드는 일은 TestHotPathGateUnderLoad가 띄워 끝내는 하위 process에서만 하고,
		// 그 process는 기한 없이 부모가 끝낼 때까지 돈다.
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
	defer db.Close()

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
			testcase.Warn("%s: client/native ratio %.2f is above its reference %.2f (docs/perf.md); machine %s %s", c.name, ratio, c.bound, runtime.GOOS, runtime.GOARCH)
		}
	}
}

func mustNoErr(tb testing.TB, f func() error) {
	tb.Helper()
	if err := f(); err != nil {
		tb.Fatal(err)
	}
}
