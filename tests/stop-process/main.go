// stop-process <signal> <pid> sends a signal to one process, and returns when the operating system's notice that the process has ended
// arrives. There is no polling and no deadline: stopping a server is a long task, and the operating system reports the
// exit by which it is judged to have ended. The watch is registered before the signal is sent, so a process that ends in between is not missed.
// A process that is already gone when registering is reported as such and treated as stopped. The watch is internal/procevent's
// WatchExit (on darwin, kqueue's EVFILT_PROC NOTE_EXIT; on linux, poll of a pidfd).
//
// scripts/test-servers.mts's stopPid runs this program that the Makefile builds (STOP_PROCESS).
package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/polyspec/orm/packages/go/procevent"
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
