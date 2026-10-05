// stop-process <signal> <pid>는 process 하나에 signal을 보내고, 그 process가 끝났다는 운영체제의 알림을
// 받으면 돌아온다. polling도 기한도 없다: 서버 정지는 장기 작업이고, 끝났는지는 운영체제가 알리는
// 종료로 판정한다. 감시를 먼저 등록한 뒤 signal을 보내므로 그 사이에 끝난 process도 놓치지 않는다.
// 등록할 때 이미 없는 process는 그 사실을 출력하고 멈춘 것으로 본다. 감시는 internal/procevent의
// WatchExit다(darwin은 kqueue의 EVFILT_PROC NOTE_EXIT, linux는 pidfd의 poll).
//
// scripts/test-servers.sh의 stop_pid가 Makefile이 build한 이 program(STOP_PROCESS)을 실행한다.
package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/polyspec/orm/internal/procevent"
	"golang.org/x/sys/unix"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: stop-process <signal> <pid>")
		os.Exit(2)
	}
	name := strings.ToUpper(os.Args[1])
	if !strings.HasPrefix(name, "SIG") {
		name = "SIG" + name
	}
	signal := unix.SignalNum(name)
	pid, err := strconv.Atoi(os.Args[2])
	if signal == 0 || err != nil || pid <= 0 {
		fmt.Fprintf(os.Stderr, "stop-process: invalid signal %q or pid %q\n", os.Args[1], os.Args[2])
		os.Exit(2)
	}
	wait, err := procevent.WatchExit(pid)
	if errors.Is(err, unix.ESRCH) {
		fmt.Printf("stop-process: process %d had already exited\n", pid)
		return
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "stop-process: watch process %d: %v\n", pid, err)
		os.Exit(1)
	}
	if err := unix.Kill(pid, signal); err != nil && !errors.Is(err, unix.ESRCH) {
		fmt.Fprintf(os.Stderr, "stop-process: send %s to %d: %v\n", name, pid, err)
		os.Exit(1)
	}
	if err := wait(); err != nil {
		fmt.Fprintf(os.Stderr, "stop-process: wait for the exit of %d: %v\n", pid, err)
		os.Exit(1)
	}
}
