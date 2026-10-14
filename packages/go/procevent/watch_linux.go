//go:build linux

package procevent

import (
	"errors"

	"golang.org/x/sys/unix"
)

// WatchExit는 pid의 pidfd를 열고, process가 끝나 pidfd가 읽을 수 있게 되기를 poll로 기다리는 함수를
// 돌려준다. 이미 없는 process는 unix.ESRCH다.
func WatchExit(pid int) (func() error, error) {
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

// WatchDir는 inotify에 directory의 변경(entry가 생기거나 없어지거나 옮겨짐)을 등록하고, 다음 변경을
// 기다리는 함수와 감시를 닫는 함수를 돌려준다. 등록은 상태를 읽기 전에 해서 그 사이의 변경을 놓치지
// 않는다.
func WatchDir(path string) (func() error, func(), error) {
	descriptor, err := unix.InotifyInit1(unix.IN_CLOEXEC)
	if err != nil {
		return nil, nil, err
	}
	if _, err := unix.InotifyAddWatch(descriptor, path, unix.IN_CREATE|unix.IN_DELETE|unix.IN_MOVED_TO|unix.IN_MOVED_FROM|unix.IN_DELETE_SELF); err != nil {
		unix.Close(descriptor)
		return nil, nil, err
	}
	buffer := make([]byte, 4096)
	return func() error {
		for {
			// read는 변경 알림이 올 때까지 막힌다.
			_, err := unix.Read(descriptor, buffer)
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return err
		}
	}, func() { unix.Close(descriptor) }, nil
}
