package orm

import (
	"syscall"
	"testing"
	"time"
)

// caseClock은 graph test 한 case의 wall-clock 시간과 test process의 CPU 시간을 함께 잰다.
// graph test의 제한 시간은 CPU 시간으로 잰다(docs/schema.md). 공유 machine에서
// wall-clock 시간은 다른 process가 CPU를 쓰는 동안 기다린 시간도 담으므로 code가 한
// 일을 재지 못한다. package orm의 test는 병렬로 돌지 않으므로 process CPU 시간은 그
// case와 Go runtime이 쓴 시간이다.
type caseClock struct {
	wall time.Time
	cpu  time.Duration
}

func startCaseClock(t *testing.T) caseClock {
	t.Helper()
	return caseClock{wall: time.Now(), cpu: processCPU(t)}
}

func (c caseClock) wallTime() time.Duration { return time.Since(c.wall) }

// assertWithin은 case의 process CPU 시간이 limit보다 짧은지 확인하고 두 시간을 기록한다.
func (c caseClock) assertWithin(t *testing.T, id string, limit time.Duration) {
	t.Helper()
	cpu, wall := processCPU(t)-c.cpu, c.wallTime()
	t.Logf("TIME %s cpu=%s wall=%s", id, cpu, wall)
	if cpu >= limit {
		t.Fatalf("%s: process CPU %s exceeds %s (wall %s)", id, cpu, limit, wall)
	}
}

// processCPU는 test process가 지금까지 쓴 user와 system CPU 시간이다.
func processCPU(t *testing.T) time.Duration {
	t.Helper()
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		t.Fatalf("getrusage: %v", err)
	}
	return time.Duration(usage.Utime.Nano() + usage.Stime.Nano())
}
