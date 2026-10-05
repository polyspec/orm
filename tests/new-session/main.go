// new-session <command> [args...]는 새 session(따라서 새 process group)을 열고 그 안에서 command를 실행한다(setsid와
// exec). scripts/test-servers.sh의 start_logged가 test server와 그 log reader를 이것으로 시작한다: server는 그것을 시작한
// 명령보다 오래 살고 여러 실행이 함께 쓰므로, 시작한 shell의 process group을 끝내는 일(terminal의 interrupt, CI step의
// 정지, 명령의 group을 끝내는 도구)이 server에 닿지 않아야 한다.
package main

import (
	"fmt"
	"os"
	"os/exec"

	"golang.org/x/sys/unix"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: new-session <command> [args...]")
		os.Exit(2)
	}
	if _, err := unix.Setsid(); err != nil {
		fmt.Fprintf(os.Stderr, "new-session: setsid: %v\n", err)
		os.Exit(1)
	}
	path, err := exec.LookPath(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "new-session: %v\n", err)
		os.Exit(127)
	}
	err = unix.Exec(path, os.Args[1:], os.Environ())
	fmt.Fprintf(os.Stderr, "new-session: exec %s: %v\n", path, err)
	os.Exit(126)
}
