// Package procevent waits for process exit and directory changes through OS notifications. There is no polling and no
// deadline: a wait ends when a notification arrives. darwin uses kqueue, and linux uses pidfd and inotify.
package procevent

import (
	"errors"

	"golang.org/x/sys/unix"
)

// Alive reports whether the process with pid exists. A process of another user (EPERM) also counts as existing.
func Alive(pid int) bool {
	err := unix.Kill(pid, 0)
	return err == nil || errors.Is(err, unix.EPERM)
}
