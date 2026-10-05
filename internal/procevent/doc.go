// Package procevent는 process 종료와 directory 변경을 운영체제의 알림으로 기다린다. polling과 기한이
// 없다: 기다림은 알림이 오면 끝난다. darwin은 kqueue, linux는 pidfd와 inotify를 쓴다.
package procevent

import (
	"errors"

	"golang.org/x/sys/unix"
)

// Alive는 pid의 process가 있는지다. 다른 사용자의 process(EPERM)도 있는 것이다.
func Alive(pid int) bool {
	err := unix.Kill(pid, 0)
	return err == nil || errors.Is(err, unix.EPERM)
}
