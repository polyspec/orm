//go:build darwin

package procevent

import (
	"errors"

	"golang.org/x/sys/unix"
)

// WatchExit registers the exit of pid (EVFILT_PROC, NOTE_EXIT) with kqueue, and returns a function that waits for that notification.
// A process that is already gone gives unix.ESRCH.
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
			// A nil timeout waits until a notification arrives. If interrupted by a signal (EINTR), it waits again.
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

// WatchDir registers changes of the directory (EVFILT_VNODE NOTE_WRITE: an entry is created or removed) with kqueue,
// and returns a function that waits for the next change and a function that closes the watch. Registration happens before the state is read, so
// no change between them is missed.
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
