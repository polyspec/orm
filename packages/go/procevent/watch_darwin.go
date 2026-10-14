//go:build darwin

package procevent

import (
	"errors"

	"golang.org/x/sys/unix"
)

// WatchExit는 kqueue에 pid의 종료(EVFILT_PROC, NOTE_EXIT)를 등록하고, 그 알림을 기다리는 함수를 돌려준다.
// 이미 없는 process는 unix.ESRCH다.
func WatchExit(pid int) (func() error, error) {
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

// WatchDir는 kqueue에 directory의 변경(EVFILT_VNODE NOTE_WRITE: entry가 생기거나 없어짐)을 등록하고,
// 다음 변경을 기다리는 함수와 감시를 닫는 함수를 돌려준다. 등록은 상태를 읽기 전에 해서 그 사이의
// 변경을 놓치지 않는다.
func WatchDir(path string) (func() error, func(), error) {
	directory, err := unix.Open(path, unix.O_RDONLY|unix.O_EVTONLY, 0)
	if err != nil {
		return nil, nil, err
	}
	queue, err := unix.Kqueue()
	if err != nil {
		unix.Close(directory)
		return nil, nil, err
	}
	var change unix.Kevent_t
	unix.SetKevent(&change, directory, unix.EVFILT_VNODE, unix.EV_ADD|unix.EV_CLEAR)
	change.Fflags = unix.NOTE_WRITE | unix.NOTE_DELETE
	if _, err := unix.Kevent(queue, []unix.Kevent_t{change}, nil, nil); err != nil {
		unix.Close(queue)
		unix.Close(directory)
		return nil, nil, err
	}
	closeAll := func() {
		unix.Close(queue)
		unix.Close(directory)
	}
	return func() error {
		events := make([]unix.Kevent_t, 1)
		for {
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
	}, closeAll, nil
}
