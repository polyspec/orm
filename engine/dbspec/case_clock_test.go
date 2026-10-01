package dbspec

import (
	"runtime"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// caseClock은 한 case의 wall-clock 시간과 그 case를 실행한 OS thread의 CPU 시간을 함께
// 잰다. test가 자기 계산에 두는 시간 제한은 CPU 시간으로 잰다(docs/dbspec.md,
// "Verification"). 공유 machine에서 wall-clock 시간은 다른 process가 CPU를 쓰는 동안 기다린
// 시간도 담으므로 code가 한 일을 재지 못한다. process CPU 시간은 다른 core에서 병렬로 도는
// garbage collector worker의 시간도 담으므로 Rust와 TypeScript client처럼 case의 thread를
// 잰다. 멈춘 case를 끊는 runTimed의 timer는 wall-clock 시간을 쓴다.
type caseClock struct {
	wall time.Time
	cpu  time.Duration
}

// startCaseClock은 goroutine을 지금 OS thread에 묶고 시계를 시작한다. 호출한 goroutine은
// elapsed를 부른 뒤 runtime.UnlockOSThread로 묶음을 푼다.
func startCaseClock(t *testing.T) caseClock {
	t.Helper()
	runtime.LockOSThread()
	return caseClock{wall: time.Now(), cpu: threadCPU(t)}
}

// elapsed는 시작 뒤 이 thread가 쓴 user와 system CPU 시간과 wall-clock 시간이다.
func (c caseClock) elapsed(t *testing.T) (cpu, wall time.Duration) {
	t.Helper()
	return threadCPU(t) - c.cpu, time.Since(c.wall)
}

// threadCPU는 지금 OS thread가 지금까지 쓴 CPU 시간이다.
func threadCPU(t *testing.T) time.Duration {
	t.Helper()
	var now unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_THREAD_CPUTIME_ID, &now); err != nil {
		t.Fatalf("clock_gettime(CLOCK_THREAD_CPUTIME_ID): %v", err)
	}
	return time.Duration(now.Nano())
}
