// lease handles the test resources that several runs share (test server, Rust target directory, TypeScript build)
// holdings as a lock file in one directory. There are two kinds of holding:
//
//	shared     several runs hold it at once. A run that uses the resource holds it.
//	exclusive  only one holds it; it cannot be obtained while a shared or another exclusive holding exists. Held by work
//	           that erases or rebuilds the resource (stop, migration, build).
//
// A holding is one file in <dir> and contains the holder (checkout path, pid, start time, command). The file is written as a
// temporary file and made by rename (shared) or link (exclusive, fails if it already exists). Shared checks, after creating it,
// whether an exclusive exists, and exclusive checks, after creating it, whether a shared exists; if so, it removes its own file and refuses. So
// two holdings never overlap.
//
// If a child process of a process holding an exclusive requests a holding again, that holding is divided within the ancestor's holding: the child
// process gets a holding by the same rules in the inner directory of the ancestor's holding (<dir>/within-<pid>-<start time>). So
// child processes that an ancestor (e.g. make feature-check) runs concurrently also block each other's exclusives, and the same process uses only
// the holding it requested again. The inner directory is removed together when the ancestor's holding is released.
//
// Waiting is not polling: when refused, it either ends at once naming the holder (without --wait), or waits for a change in the directory
// through the operating system's notification (internal/procevent) and then acquires again (--wait).
//
// The holding of hold is removed by a releaser process (release-on-exit) after the holder process ends, so the holding file also records the
// releaser's pid. A holding whose holder has ended while the releaser is alive is being released: --wait waits for a directory change or the releaser's
// exit. A holding where both holder and releaser are gone (a dead holding) is taken without blocking, since nobody removes it.
// shared only read the resource, so anyone may remove its file and proceed. An exclusive may have left the resource partly changed, so only
// the next exclusive holder takes it and rebuilds the resource. A run requesting shared is refused so that it does not read a resource left by a dead exclusive,
// and the refusal message states it. The holding taken is written to stderr. clear-dead
// explicitly removes dead holdings and reports what it removed.
//
// Usage:
//
//	lease hold <dir> shared|exclusive [--wait] --pid <pid>
//	                                                  holds until the process with pid ends. If pid already holds an exclusive,
//	                                                  it uses that holding as is; if an ancestor process holds it, that holding
//	                                                  is taken within it
//	lease run <dir> shared|exclusive [--wait] -- <command> [args...]
//	                                                  holds it while the command runs
//	lease list <dir>                                  prints the holders
//	lease clear-dead <dir>                            removes dead holdings and prints them
package main

import (
	"bufio"
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

	"github.com/polyspec/orm/packages/go/procevent"
)

const exclusiveName = "exclusive.json"

// errHeld means this process already holds an exclusive. hold uses that holding as is.
var errHeld = errors.New("the process already holds the exclusive lease")

// errAgain means that while waiting in the inner directory, the ancestor's holding was released. It acquires again from the outer directory.
var errAgain = errors.New("the enclosing lease was released")

// inside means the ancestor process holds the exclusive. The holding is taken in that holding's inner directory.
type inside struct {
	holder holder
}

func (i inside) Error() string {
	return "an ancestor process holds the exclusive lease: " + i.holder.String()
}

// within is the inner directory of exclusive holding h. The child processes of the process that holds it divide holdings here.
func within(dir string, h holder) string {
	return filepath.Join(dir, fmt.Sprintf("within-%d-%s", h.PID, strings.ReplaceAll(h.Started, ":", "")))
}

// release removes the holding file and, if it was an exclusive, also its inner directory. A holding that another run
// already removed is released.
func release(file string) error {
	text, err := os.ReadFile(file)
	var h holder
	if err == nil && json.Unmarshal(text, &h) == nil && h.Kind == "exclusive" {
		removed := remove(file)
		return errors.Join(removed, os.RemoveAll(within(filepath.Dir(file), h)))
	}
	return remove(file)
}

// mustRelease releases the holding file, and ends the process with status 1 when the holding cannot be removed.
func mustRelease(file string) {
	if err := release(file); err != nil {
		fmt.Fprintf(os.Stderr, "lease: release %s: %v\n", file, err)
		os.Exit(1)
	}
}

// remove removes path; a path that no longer exists is removed.
func remove(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// holder is the content of the holding file.
type holder struct {
	Kind     string `json:"kind"`
	Checkout string `json:"checkout"`
	PID      int    `json:"pid"`
	Started  string `json:"started"`
	Command  string `json:"command"`
	// Releaser is the pid of the release-on-exit process left by hold. For run's holding, the holder removes it itself, so it is 0.
	Releaser int `json:"releaser,omitempty"`
	file     string
}

// releasing means the holder has ended but the releaser that will remove the holding is still alive.
func (h holder) releasing() bool {
	return !procevent.Alive(h.PID) && h.Releaser != 0 && procevent.Alive(h.Releaser)
}

// gone means neither the holder nor the releaser exists. Nobody removes that holding.
func (h holder) gone() bool {
	return !procevent.Alive(h.PID) && (h.Releaser == 0 || !procevent.Alive(h.Releaser))
}

func (h holder) String() string {
	state := "running"
	if h.releasing() {
		state = fmt.Sprintf("ended, releaser %d running", h.Releaser)
	} else if h.gone() {
		state = "dead"
	}
	return fmt.Sprintf("%s lease of pid %d (%s) from %s since %s: %s", h.Kind, h.PID, state, h.Checkout, h.Started, h.Command)
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: lease hold <dir> shared|exclusive --pid <pid> | lease run <dir> shared|exclusive [--wait] -- <command>... | lease list <dir> | lease clear-dead <dir>")
	os.Exit(2)
}

// refusal is the reason the holding could not be obtained and the blocking holder.
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

// current checks whether h's file still records the same holder; the holder ends after removing the file, and the same name (exclusive.json)
// may be created again by another holder, so it checks both whether the file exists and whether its pid matches.
func current(h holder) bool {
	text, err := os.ReadFile(h.file)
	if err != nil {
		return false
	}
	var now holder
	return json.Unmarshal(text, &now) == nil && now.PID == h.PID && now.Started == h.Started
}

// dead means: among blocking holdings, whether any remain where both holder and releaser are gone. It looks again after checking the process,
// to see whether the holding still remains: a holding that ended normally is removed in between.
func (r refusal) dead() bool {
	for _, h := range r.blocking {
		if h.gone() && current(h) {
			return true
		}
	}
	return false
}

// releasers is the releaser pid of those blocking holdings that are being released.
func (r refusal) releasers() []int {
	var out []int
	for _, h := range r.blocking {
		if h.releasing() {
			out = append(out, h.Releaser)
		}
	}
	return out
}

// takeOver removes the dead holdings that a run requesting kind may take, and returns whether anything was removed. A dead shared
// may be taken by anyone; a dead exclusive is taken only by a run requesting exclusive. Just before removing, it checks whether the file is still the same holding.
func (r refusal) takeOver(kind string) bool {
	took := false
	for _, h := range r.blocking {
		if !h.gone() || !current(h) || (h.Kind == "exclusive" && kind != "exclusive") {
			continue
		}
		if err := release(h.file); err != nil {
			fmt.Fprintf(os.Stderr, "lease: take over the dead %s: %v\n", h, err)
			continue
		}
		fmt.Fprintf(os.Stderr, "lease: took over the dead %s\n", h)
		took = true
	}
	return took
}

// released means whether any blocking holding has already been released. If so, it retries without waiting.
func (r refusal) released() bool {
	for _, h := range r.blocking {
		if !current(h) {
			return true
		}
	}
	return false
}

// holders reads the holdings in dir in name order. A temporary file being written (.tmp-) is not a holding.
func holders(dir string) ([]holder, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []holder
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
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

// acquire tries once to take a holding of kind under the name pid. If it succeeds it returns the holding file's path; if blocked, it returns a refusal
// instead.
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
	// The temporary file is gone after a rename and stays after a link; one that cannot be removed holds nothing,
	// since holders reads only the holding files, and is reported.
	defer func() {
		if err := remove(temporary); err != nil {
			fmt.Fprintf(os.Stderr, "lease: remove %s: %v\n", temporary, err)
		}
	}()
	if kind == "shared" {
		file := filepath.Join(dir, fmt.Sprintf("shared-%d-%s.json", pid, random()))
		if err := os.Rename(temporary, file); err != nil {
			return "", err
		}
		all, err := holders(dir)
		if err != nil {
			return "", errors.Join(err, remove(file))
		}
		for _, h := range all {
			if h.Kind == "exclusive" {
				if err := remove(file); err != nil {
					return "", err
				}
				// If this process holds an exclusive, it is already inside that holding; if an ancestor process holds it, it acquires within that holding.
				if h.PID == pid {
					return "", errHeld
				}
				if ancestorOrSelf(h.PID, pid) {
					return "", inside{holder: h}
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
					// An exclusive already held by the same process belongs to that process. Within an exclusive held by an ancestor process (e.g. the make
					// that ran the child make), its child processes divide holdings in the inner directory.
					if h.PID == pid {
						return "", errHeld
					}
					if ancestorOrSelf(h.PID, pid) {
						return "", inside{holder: h}
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
		return "", errors.Join(err, remove(file))
	}
	var blocking []holder
	for _, h := range all {
		if h.file != file {
			blocking = append(blocking, h)
		}
	}
	if len(blocking) > 0 {
		if err := remove(file); err != nil {
			return "", err
		}
		return "", refusal{blocking: blocking}
	}
	return file, nil
}

// acquireWaiting calls acquire, and if wait, when blocked, waits for a change notification in dir and retries. Watching is registered before
// the attempt. If a dead holding is blocking, it does not wait. If an ancestor process holds an exclusive, it does the same
// in the inner directory; if the ancestor's holding (enclosing) is released while waiting there, it acquires again from the outer directory.
func acquireWaiting(dir, kind string, pid int, command string, wait bool, enclosing *holder) (string, error) {
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
		var ancestor inside
		if errors.As(err, &ancestor) {
			if err := closeWatch(); err != nil {
				return "", err
			}
			file, err = acquireWaiting(within(dir, ancestor.holder), kind, pid, command, wait, &ancestor.holder)
			if errors.Is(err, errAgain) {
				continue
			}
			return file, err
		}
		var refused refusal
		if errors.As(err, &refused) && refused.released() {
			// The holding that caused the refusal was released in the meantime. The change notification came after the watch was registered, so it retries without waiting.
			if err := closeWatch(); err != nil {
				return "", err
			}
			continue
		}
		if errors.As(err, &refused) && refused.takeOver(kind) {
			// Took over a dead holding. Retries with no holding present.
			if err := closeWatch(); err != nil {
				return "", err
			}
			continue
		}
		if err == nil || !wait || !errors.As(err, &refused) || refused.dead() {
			if closeErr := closeWatch(); closeErr != nil {
				if err == nil {
					// The holding was acquired; a run that fails does not keep it.
					return "", errors.Join(closeErr, release(file))
				}
				return "", errors.Join(err, closeErr)
			}
			return file, err
		}
		if !announced {
			fmt.Fprintf(os.Stderr, "lease: waiting for the %s lease of %s; %v\n", kind, dir, err)
			announced = true
		}
		err = errors.Join(waitChange(next, refused.releasers()), closeWatch())
		if err != nil {
			return "", err
		}
		if enclosing != nil && !current(*enclosing) {
			return "", errAgain
		}
	}
}

// waitChange waits for the next change in the directory, or for the exit of one of the releasers of holdings being released. If a releaser
// ends without removing the holding, the directory does not change, so it also waits for that exit.
func waitChange(next func() error, releasers []int) error {
	done := make(chan error, 1+len(releasers))
	go func() { done <- next() }()
	for _, pid := range releasers {
		wait, err := procevent.WatchExit(pid)
		if err != nil {
			if errors.Is(err, syscall.ESRCH) {
				return nil
			}
			return err
		}
		go func() { done <- wait() }()
	}
	return <-done
}

func refuse(dir, kind string, err error) {
	var refused refusal
	if errors.As(err, &refused) {
		hint := ""
		if refused.dead() {
			hint = "\nthe dead exclusive holder may have left the resource half made; the next exclusive holder takes its lease over and makes the resource again"
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
		// hold <dir> <kind> [--wait] --pid <pid>: acquires the holding, waits for pid to exit, and leaves a process that removes the holding.
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
		file, err := acquireWaiting(dir, os.Args[3], pid, parentCommand(pid), wait, nil)
		if errors.Is(err, errHeld) {
			return
		}
		if err != nil {
			refuse(dir, os.Args[3], err)
		}
		// The releaser writes its pid into the holding file, then writes one line to stdout. hold ends only after receiving that line, so if the holder
		// ends after hold, a run waiting for that holding waits while the releaser is alive.
		releaser := exec.Command(os.Args[0], "release-on-exit", file, strconv.Itoa(pid))
		releaser.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		recorded, err := releaser.StdoutPipe()
		if err == nil {
			err = releaser.Start()
		}
		if err != nil {
			mustRelease(file)
			fmt.Fprintf(os.Stderr, "lease: start the releaser: %v\n", err)
			os.Exit(1)
		}
		line, err := bufio.NewReader(recorded).ReadString('\n')
		if err != nil {
			mustRelease(file)
			fmt.Fprintf(os.Stderr, "lease: read the record of the releaser of %s: %v\n", file, err)
			os.Exit(1)
		}
		if line != "recorded\n" {
			mustRelease(file)
			fmt.Fprintf(os.Stderr, "lease: the releaser of %s did not record itself\n", file)
			os.Exit(1)
		}
		// The releaser runs in its own session and outlives hold; hold does not wait for it.
		if err := releaser.Process.Release(); err != nil {
			fmt.Fprintf(os.Stderr, "lease: release the releaser process: %v\n", err)
		}
	case "release-on-exit":
		// release-on-exit <file> <pid>: the process hold leaves behind. On receiving the exit notice of pid, it removes the holding and its inner
		// directory.
		if len(os.Args) != 4 {
			usage()
		}
		pid, err := strconv.Atoi(os.Args[3])
		if err != nil {
			usage()
		}
		file := os.Args[2]
		signal.Ignore(syscall.SIGHUP, syscall.SIGINT, syscall.SIGPIPE)
		if err := recordReleaser(file, os.Getpid()); err != nil {
			fmt.Fprintf(os.Stderr, "lease: record the releaser in %s: %v\n", file, err)
			os.Exit(1)
		}
		// hold waits for this line. After that it closes stdout: once hold ends, nothing reads it.
		fmt.Println("recorded")
		if err := os.Stdout.Close(); err != nil {
			fmt.Fprintf(os.Stderr, "lease: close stdout: %v\n", err)
		}
		wait, err := procevent.WatchExit(pid)
		if err == nil {
			err = wait()
		}
		if err != nil && !errors.Is(err, syscall.ESRCH) {
			fmt.Fprintf(os.Stderr, "lease: watch pid %d: %v\n", pid, err)
			os.Exit(1)
		}
		mustRelease(file)
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
		file, err := acquireWaiting(dir, kind, os.Getpid(), strings.Join(rest[1:], " "), wait, nil)
		if err != nil {
			refuse(dir, kind, err)
		}
		child := exec.Command(rest[1], rest[2:]...)
		child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
		// The command is in the same process group, so a terminal interrupt reaches the command too. This process
		// does not end by signal; it waits for the command to finish, then removes the holding.
		signal.Ignore(syscall.SIGINT, syscall.SIGQUIT)
		runErr := child.Run()
		mustRelease(file)
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
		all, err := nestedHolders(dir)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "lease: %v\n", err)
			os.Exit(1)
		}
		if len(all) == 0 {
			fmt.Printf("lease: no lease of %s\n", dir)
		}
		for _, h := range all {
			if filepath.Dir(h.file) != filepath.Clean(dir) {
				fmt.Printf("%s (within %s)\n", h, filepath.Dir(h.file))
				continue
			}
			fmt.Println(h)
		}
	case "clear-dead":
		all, err := nestedHolders(dir)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "lease: %v\n", err)
			os.Exit(1)
		}
		removed := 0
		for _, h := range all {
			if !h.gone() {
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

// recordReleaser writes the holding file again under the same name with the releaser pid added. The rewrite is a rename of a temporary file,
// so the reader always sees one complete file.
func recordReleaser(file string, pid int) error {
	text, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var h holder
	if err := json.Unmarshal(text, &h); err != nil {
		return err
	}
	h.Releaser = pid
	text, err = json.Marshal(h)
	if err != nil {
		return err
	}
	temporary := filepath.Join(filepath.Dir(file), ".tmp-"+random())
	if err := os.WriteFile(temporary, text, 0o644); err != nil {
		return err
	}
	return os.Rename(temporary, file)
}

// nestedHolders reads both the holdings in dir and those in its inner directory (within-).
func nestedHolders(dir string) ([]holder, error) {
	out, err := holders(dir)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "within-") {
			continue
		}
		inner, err := nestedHolders(filepath.Join(dir, entry.Name()))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		out = append(out, inner...)
	}
	return out, nil
}

// ancestorOrSelf checks whether the holder is pid itself or one of its ancestor processes. Ancestors are found by following parent process ids with ps.
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

// parentCommand records the command of the holder process. If it cannot be read, it records only the pid.
func parentCommand(pid int) string {
	output, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return "pid " + strconv.Itoa(pid)
	}
	return strings.TrimSpace(string(output))
}
