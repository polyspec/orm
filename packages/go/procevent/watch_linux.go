//go:build linux

package procevent

import (
	"errors"

	"golang.org/x/sys/unix"
)

// WatchExit opens the pidfd of pid, and returns a function that waits with poll until the pidfd becomes readable, which happens when the process ends.
// A process that is already gone gives unix.ESRCH.
func WatchExit(pid int) (func() error, error) {
	descriptor, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		return nil, err
	}
	return func() error {
		defer unix.Close(descriptor)
		fds := []unix.PollFd{{Fd: int32(descriptor), Events: unix.POLLIN}}
		for {
			// A timeout of -1 waits until a notification arrives. If interrupted by a signal (EINTR), it waits again.
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

// WatchDir registers changes of the directory (an entry is created, removed, or moved) with inotify, and returns a function that waits for the next change
// and a function that closes the watch. Registration happens before the state is read, so no change
// between them is missed.
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
			// read blocks until a change notification arrives.
			_, err := unix.Read(descriptor, buffer)
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return err
		}
	}, func() { unix.Close(descriptor) }, nil
}
