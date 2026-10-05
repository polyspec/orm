// lease는 여러 실행이 함께 쓰는 test 자원(test server, Rust target directory, TypeScript build)의
// 보유를 directory 하나의 lock file로 다룬다. 보유는 두 가지다:
//
//	shared     여러 실행이 동시에 가진다. 자원을 쓰는 실행이 가진다.
//	exclusive  하나만 가지고, shared나 다른 exclusive가 있으면 얻지 못한다. 자원을 지우거나 다시 만드는
//	           일(정지, migration, build)이 가진다.
//
// 보유 하나는 <dir>의 file 하나이고 보유자(checkout path, pid, 시작 시각, 명령)를 담는다. file은 다른 이름의
// 임시 file을 쓴 뒤 rename(shared)이나 link(exclusive, 이미 있으면 실패)로 만든다. shared는 만든 뒤
// exclusive가 있는지, exclusive는 만든 뒤 shared가 있는지 보고, 있으면 자기 file을 지우고 거부한다. 그래서
// 두 보유가 겹치지 않는다.
//
// 기다리는 일은 polling이 아니다: 거부되면 곧바로 보유자를 적고 끝나거나(--wait 없음), directory 변경을
// 운영체제의 알림(internal/procevent)으로 기다린 뒤 다시 얻는다(--wait). 보유자 process가 없어진 보유(죽은
// 보유)는 저절로 가져가지 않는다: 거부 message가 그것을 죽은 보유로 적고, clear-dead가 명시적으로 지우며
// 지운 것을 보고한다. 죽은 보유가 막고 있으면 --wait도 기다리지 않고 거부한다.
//
// Usage:
//
//	lease hold <dir> shared|exclusive [--wait] --pid <pid>
//	                                                  pid의 process가 끝날 때까지 보유한다. pid나 그 조상 process가
//	                                                  이미 exclusive를 가지면 그 보유를 그대로 쓴다
//	lease run <dir> shared|exclusive [--wait] -- <command> [args...]
//	                                                  command를 실행하는 동안 보유한다
//	lease list <dir>                                  보유자를 적는다
//	lease clear-dead <dir>                            죽은 보유를 지우고 적는다
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/polyspec/orm/internal/procevent"
)

const exclusiveName = "exclusive.json"

// errHeld는 그 process나 조상 process가 이미 exclusive를 가지고 있다는 뜻이다. hold는 그 보유를 그대로 쓴다.
var errHeld = errors.New("the process already holds the exclusive lease")

// holder는 보유 file의 내용이다.
type holder struct {
	Kind     string `json:"kind"`
	Checkout string `json:"checkout"`
	PID      int    `json:"pid"`
	Started  string `json:"started"`
	Command  string `json:"command"`
	file     string
}

func (h holder) String() string {
	state := "running"
	if !procevent.Alive(h.PID) {
		state = "dead"
	}
	return fmt.Sprintf("%s lease of pid %d (%s) from %s since %s: %s", h.Kind, h.PID, state, h.Checkout, h.Started, h.Command)
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: lease hold <dir> shared|exclusive --pid <pid> | lease run <dir> shared|exclusive [--wait] -- <command>... | lease list <dir> | lease clear-dead <dir>")
	os.Exit(2)
}

// refusal은 보유를 얻지 못한 이유와 막는 보유자다.
type refusal struct {
	blocking []holder
}

func (r refusal) Error() string {
	lines := make([]string, len(r.blocking))
	for i, h := range r.blocking {
		lines[i] = "  " + h.String()
	}
	return "held by:\n" + strings.Join(lines, "\n")
}

// current는 h의 file이 아직 같은 보유자를 담는지다. 보유자는 file을 지운 뒤에 끝나고, 같은 이름(exclusive.json)은
// 다른 보유자가 다시 만들 수 있으므로, file이 있는지와 그 pid가 같은지를 함께 본다.
func current(h holder) bool {
	text, err := os.ReadFile(h.file)
	if err != nil {
		return false
	}
	var now holder
	return json.Unmarshal(text, &now) == nil && now.PID == h.PID && now.Started == h.Started
}

// dead는 막는 보유 가운데 보유자 process가 없는데 그 보유가 아직 남은 것이 있는지다. process를 본 뒤에 보유가
// 남았는지 다시 본다: 정상으로 끝난 보유자는 그 사이에 자기 file을 지운다.
func (r refusal) dead() bool {
	for _, h := range r.blocking {
		if !procevent.Alive(h.PID) && current(h) {
			return true
		}
	}
	return false
}

// released는 막는 보유 가운데 이미 풀린 것이 있는지다. 그러면 기다리지 않고 다시 시도한다.
func (r refusal) released() bool {
	for _, h := range r.blocking {
		if !current(h) {
			return true
		}
	}
	return false
}

// holders는 dir의 보유를 이름 순서로 읽는다. 쓰는 중인 임시 file(.tmp-)은 보유가 아니다.
func holders(dir string) ([]holder, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []holder
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		text, err := os.ReadFile(filepath.Join(dir, name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		var h holder
		if err := json.Unmarshal(text, &h); err != nil {
			return nil, fmt.Errorf("lease file %s: %w", filepath.Join(dir, name), err)
		}
		h.file = filepath.Join(dir, name)
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].file < out[j].file })
	return out, nil
}

func random() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// acquire는 kind의 보유를 pid의 이름으로 한 번 시도한다. 얻으면 보유 file의 경로를, 막히면 refusal을
// 돌려준다.
func acquire(dir, kind string, pid int, command string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	checkout, err := os.Getwd()
	if err != nil {
		return "", err
	}
	text, err := json.Marshal(holder{Kind: kind, Checkout: checkout, PID: pid, Started: time.Now().UTC().Format(time.RFC3339), Command: command})
	if err != nil {
		return "", err
	}
	temporary := filepath.Join(dir, ".tmp-"+random())
	if err := os.WriteFile(temporary, text, 0o644); err != nil {
		return "", err
	}
	defer os.Remove(temporary)
	if kind == "shared" {
		file := filepath.Join(dir, fmt.Sprintf("shared-%d-%s.json", pid, random()))
		if err := os.Rename(temporary, file); err != nil {
			return "", err
		}
		all, err := holders(dir)
		if err != nil {
			os.Remove(file)
			return "", err
		}
		for _, h := range all {
			if h.Kind == "exclusive" {
				os.Remove(file)
				// 조상 process가 exclusive를 가지면 이 process는 이미 그 보유 안에 있다.
				if ancestorOrSelf(h.PID, pid) {
					return "", errHeld
				}
				return "", refusal{blocking: []holder{h}}
			}
		}
		return file, nil
	}
	file := filepath.Join(dir, exclusiveName)
	if err := os.Link(temporary, file); err != nil {
		if errors.Is(err, os.ErrExist) {
			all, readErr := holders(dir)
			if readErr != nil {
				return "", readErr
			}
			var blocking []holder
			for _, h := range all {
				if h.Kind == "exclusive" {
					// 같은 process나 그 조상 process(예: 하위 make를 실행한 make)가 이미 가진 exclusive는 그 process의 것이다.
					if ancestorOrSelf(h.PID, pid) {
						return "", errHeld
					}
					blocking = append(blocking, h)
				}
			}
			return "", refusal{blocking: blocking}
		}
		return "", err
	}
	all, err := holders(dir)
	if err != nil {
		os.Remove(file)
		return "", err
	}
	var blocking []holder
	for _, h := range all {
		if h.file != file {
			blocking = append(blocking, h)
		}
	}
	if len(blocking) > 0 {
		os.Remove(file)
		return "", refusal{blocking: blocking}
	}
	return file, nil
}

// acquireWaiting은 acquire를 하고, wait이면 막힐 때 dir의 변경 알림을 기다려 다시 시도한다. 감시는 시도
// 전에 등록한다. 죽은 보유가 막으면 기다리지 않는다.
func acquireWaiting(dir, kind string, pid int, command string, wait bool) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	announced := false
	for {
		next, closeWatch, err := procevent.WatchDir(dir)
		if err != nil {
			return "", err
		}
		file, err := acquire(dir, kind, pid, command)
		var refused refusal
		if errors.As(err, &refused) && refused.released() {
			// 거부를 만든 보유가 그 사이에 풀렸다. 그 변경 알림은 감시 등록 뒤에 왔으므로 기다리지 않고 다시 시도한다.
			closeWatch()
			continue
		}
		if err == nil || !wait || !errors.As(err, &refused) || refused.dead() {
			closeWatch()
			return file, err
		}
		if !announced {
			fmt.Fprintf(os.Stderr, "lease: waiting for the %s lease of %s; %v\n", kind, dir, err)
			announced = true
		}
		err = next()
		closeWatch()
		if err != nil {
			return "", err
		}
	}
}

func refuse(dir, kind string, err error) {
	var refused refusal
	if errors.As(err, &refused) {
		hint := ""
		if refused.dead() {
			hint = fmt.Sprintf("\na dead lease is never taken over; remove it with: lease clear-dead %s", dir)
		}
		fmt.Fprintf(os.Stderr, "lease: refused the %s lease of %s; %v%s\n", kind, dir, err, hint)
		os.Exit(3)
	}
	fmt.Fprintf(os.Stderr, "lease: %v\n", err)
	os.Exit(1)
}

func kindArgument(kind string) {
	if kind != "shared" && kind != "exclusive" {
		usage()
	}
}

func main() {
	if len(os.Args) < 3 {
		usage()
	}
	command, dir := os.Args[1], os.Args[2]
	switch command {
	case "hold":
		// hold <dir> <kind> [--wait] --pid <pid>: 보유를 얻고, pid의 종료를 기다려 보유를 지우는 process를 남긴다.
		rest := os.Args[4:]
		wait := false
		if len(rest) > 0 && rest[0] == "--wait" {
			wait = true
			rest = rest[1:]
		}
		if len(rest) != 2 || rest[0] != "--pid" {
			usage()
		}
		kindArgument(os.Args[3])
		pid, err := strconv.Atoi(rest[1])
		if err != nil || pid <= 0 {
			usage()
		}
		file, err := acquireWaiting(dir, os.Args[3], pid, parentCommand(pid), wait)
		if errors.Is(err, errHeld) {
			return
		}
		if err != nil {
			refuse(dir, os.Args[3], err)
		}
		releaser := exec.Command(os.Args[0], "release-on-exit", file, strconv.Itoa(pid))
		releaser.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := releaser.Start(); err != nil {
			os.Remove(file)
			fmt.Fprintf(os.Stderr, "lease: start the releaser: %v\n", err)
			os.Exit(1)
		}
		releaser.Process.Release()
	case "release-on-exit":
		// release-on-exit <file> <pid>: hold가 남기는 process다. pid의 종료 알림을 받으면 보유를 지운다.
		if len(os.Args) != 4 {
			usage()
		}
		pid, err := strconv.Atoi(os.Args[3])
		if err != nil {
			usage()
		}
		file := os.Args[2]
		signal.Ignore(syscall.SIGHUP, syscall.SIGINT)
		wait, err := procevent.WatchExit(pid)
		if err == nil {
			err = wait()
		}
		if err != nil && !errors.Is(err, syscall.ESRCH) {
			fmt.Fprintf(os.Stderr, "lease: watch pid %d: %v\n", pid, err)
			os.Exit(1)
		}
		os.Remove(file)
	case "run":
		if len(os.Args) < 6 {
			usage()
		}
		kind := os.Args[3]
		kindArgument(kind)
		rest := os.Args[4:]
		wait := false
		if rest[0] == "--wait" {
			wait = true
			rest = rest[1:]
		}
		if len(rest) < 2 || rest[0] != "--" {
			usage()
		}
		file, err := acquireWaiting(dir, kind, os.Getpid(), strings.Join(rest[1:], " "), wait)
		if err != nil {
			refuse(dir, kind, err)
		}
		child := exec.Command(rest[1], rest[2:]...)
		child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
		// 명령은 같은 process group에 있으므로 terminal의 interrupt는 명령에도 닿는다. 이 process는 그
		// signal로 끝나지 않고 명령이 끝나기를 기다려 보유를 지운다.
		signal.Ignore(syscall.SIGINT, syscall.SIGQUIT)
		runErr := child.Run()
		os.Remove(file)
		var exit *exec.ExitError
		if errors.As(runErr, &exit) {
			if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				os.Exit(128 + int(status.Signal()))
			}
			os.Exit(exit.ExitCode())
		}
		if runErr != nil {
			fmt.Fprintf(os.Stderr, "lease: run %s: %v\n", rest[1], runErr)
			os.Exit(1)
		}
	case "list":
		all, err := holders(dir)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "lease: %v\n", err)
			os.Exit(1)
		}
		if len(all) == 0 {
			fmt.Printf("lease: no lease of %s\n", dir)
		}
		for _, h := range all {
			fmt.Println(h)
		}
	case "clear-dead":
		all, err := holders(dir)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "lease: %v\n", err)
			os.Exit(1)
		}
		removed := 0
		for _, h := range all {
			if procevent.Alive(h.PID) {
				continue
			}
			if err := os.Remove(h.file); err != nil && !errors.Is(err, os.ErrNotExist) {
				fmt.Fprintf(os.Stderr, "lease: remove %s: %v\n", h.file, err)
				os.Exit(1)
			}
			fmt.Printf("lease: removed the dead %s\n", h)
			removed++
		}
		fmt.Printf("lease: removed %d dead lease(s) of %s\n", removed, dir)
	default:
		usage()
	}
}

// ancestorOrSelf는 holder가 pid 자신이거나 그 조상 process인지다. 조상은 ps로 parent process id를 따라 찾는다.
func ancestorOrSelf(holder, pid int) bool {
	for current := pid; current > 1; {
		if current == holder {
			return true
		}
		output, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(current)).Output()
		if err != nil {
			return false
		}
		parent, err := strconv.Atoi(strings.TrimSpace(string(output)))
		if err != nil || parent == current {
			return false
		}
		current = parent
	}
	return false
}

// parentCommand는 보유자 process의 명령을 적는다. 읽을 수 없으면 pid만 적는다.
func parentCommand(pid int) string {
	output, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return "pid " + strconv.Itoa(pid)
	}
	return strings.TrimSpace(string(output))
}
