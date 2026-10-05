//go:build darwin

package main

import (
	"errors"

	"golang.org/x/sys/unix"
)

// watch는 kqueue에 pid의 종료(EVFILT_PROC, NOTE_EXIT)를 등록하고, 그 알림을 기다리는 함수를 돌려준다.
// 이미 없는 process는 unix.ESRCH다.
func watch(pid int) (func() error, error) {
	queue, err := unix.Kqueue()
	if err != nil {
		return nil, err
	}
	var change unix.Kevent_t
	unix.SetKevent(&change, pid, unix.EVFILT_PROC, unix.EV_ADD|unix.EV_ONESHOT)
	change.Fflags = unix.NOTE_EXIT
	if _, err := unix.Kevent(queue, []unix.Kevent_t{change}, nil, nil); err != nil {
		unix.Close(queue)
		return nil, err
	}
	return func() error {
		defer unix.Close(queue)
		events := make([]unix.Kevent_t, 1)
		for {
			// timeout nil은 알림이 올 때까지 기다린다. signal에 끊기면(EINTR) 다시 기다린다.
			n, err := unix.Kevent(queue, nil, events, nil)
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
