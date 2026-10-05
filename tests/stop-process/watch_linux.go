//go:build linux

package main

import (
	"errors"

	"golang.org/x/sys/unix"
)

// watch는 pid의 pidfd를 열고, process가 끝나 pidfd가 읽을 수 있게 되기를 poll로 기다리는 함수를
// 돌려준다. 이미 없는 process는 unix.ESRCH다.
func watch(pid int) (func() error, error) {
	descriptor, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		return nil, err
	}
	return func() error {
		defer unix.Close(descriptor)
		fds := []unix.PollFd{{Fd: int32(descriptor), Events: unix.POLLIN}}
		for {
			// timeout -1은 알림이 올 때까지 기다린다. signal에 끊기면(EINTR) 다시 기다린다.
			n, err := unix.Poll(fds, -1)
			if errors.Is(err, unix.EINTR) {
				continue
			}
			if err != nil {
				return err
			}
			if n == 1 {
				return nil
			}
		}
	}, nil
}
