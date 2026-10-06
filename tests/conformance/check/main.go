// Conformance checker: runs the client runners (or reads their outputs) and
// compares each vector's statements and result against tests/conformance/vectors.json
// with exact JSON number comparison and sorted object keys in diagnostics.
//
//	go run ./tests/conformance/check run -out <new dir> -dsn … [-driver postgres|sqlite]  # run all four runners twice, then compare
//	go run ./tests/conformance/check run -out <new dir> -driver mysql -dsn … -driver postgres -dsn … -driver sqlite -dsn …  # build once, check each database
//	go run ./tests/conformance/check compare [-driver …] out/…                                  # compare produced outputs (<lang>.json)
//	go run ./tests/conformance/check record [-driver …] out/{go,php,rust,typescript}.json       # record agreed expectations
//
// `run` writes the verified outputs of a database into -out (MySQL) or -out/<driver>,
// a directory that must not exist yet: every run starts from an empty directory of
// its own, so no reader takes the outputs of an earlier run for this one.
//
// Expectations live in tests/conformance/vectors.json (MySQL) and
// tests/conformance/vectors.<driver>.json for the other databases: statements
// differ per dialect, results must not.
//
// `run` holds a file lock (flock) per bench database (orm-conformance-<DSN hash>.lock in
// the temporary directory) while the runners use it; a second run on the same database
// fails instead of waiting, runs on other databases do not conflict, and the lock of a
// run that ended in any way no longer holds.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/polyspec/orm/internal/stmtdiff"
	"github.com/polyspec/orm/internal/testcase"
)

// runner 실행과 확인의 기한이다. runner의 build는 장기 작업이므로 기한 없이 run 한 번에 한 번만
// 하고(testcase.RunLong, 명령 출력을 단계로), 모든 database와 두 번의 실행이 build된 runner를 실행한다.
const (
	// runnerDeadline: build된 runner process 하나가 bench database에서 모든 vector를 실행한다
	// (개발 machine에서 1-3 s). 1분이 지난 runner는 멈춘 것이다.
	runnerDeadline = time.Minute
	// stateDeadline: database state digest(state.go)나 counter(counters.go의 30 s)를 읽고
	// 되돌리는 일 하나의 기한이다. bench database의 digest는 1 s 안에 읽힌다.
	stateDeadline = time.Minute
	// languageDeadline: 한 언어의 case는 runner를 두 번 실행하고, 실행마다 state를 앞뒤로
	// 읽고 counter를 되돌린다(8분).
	languageDeadline = 2*runnerDeadline + 6*stateDeadline
	// compareDeadline: 네 output을 vector 기대값과 비교하는 memory 안의 계산이다.
	compareDeadline = testcase.Compute
)

type vec struct {
	Name   string          `json:"name"`
	Chain  string          `json:"chain"`
	Expect json.RawMessage `json:"expect"`
}

type file struct {
	Vectors []vec `json:"vectors"`
}

// driver selects the database: "mysql" (default) or postgres/sqlite. Every
// runner takes it as a driver flag, and the expectations file follows it.
// selected는 -vector가 고른 vector 이름이다. 비어 있으면 모든 vector다. run은 runner에게 그
// 이름만 실행하게 하고, compare와 record는 그 vector만 비교하고 기록한다.
var selected listFlag

// chosen은 이름이 고른 vector인지다.
func chosen(name string) bool { return len(selected) == 0 || slices.Contains(selected, name) }

var (
	driver string
	dsn    string
	// outRoot는 run이 검증된 output을 쓰는 directory다(-out). run마다 새 directory다.
	outRoot string
)

// listFlag는 여러 번 줄 수 있는 flag다. run은 -driver와 -dsn을 순서대로 짝짓는다.
type listFlag []string

func (l *listFlag) String() string { return strings.Join(*l, ",") }

func (l *listFlag) Set(value string) error {
	*l = append(*l, value)
	return nil
}

var requiredLanguages = []string{"go", "php", "rust", "typescript"}

func vectorsPath() string {
	if driver == "" || driver == "mysql" {
		return "tests/conformance/vectors.json"
	}
	return "tests/conformance/vectors." + driver + ".json"
}

// main은 run의 종료 코드로 끝난다. os.Exit는 defer를 실행하지 않으므로 run 안에서는 부르지 않는다: 실패(must,
// usage)는 panic으로 run까지 올라오고, 그 사이의 defer가 runner binary directory를 지우며, run이 잡은 lock을 푼다.
func main() {
	os.Exit(run())
}

// exitCode는 usage가 run을 끝내는 panic이다. failure는 must가 run을 끝내는 panic이다.
type exitCode int
type failure struct{ err error }

func (f failure) Error() string { return f.err.Error() }

func run() (code int) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		switch r := recovered.(type) {
		case exitCode:
			code = int(r)
		case failure:
			fmt.Fprintln(os.Stderr, "check:", r.err)
			code = 1
		default:
			panic(recovered)
		}
		if cleanupErr := releaseLocks(); cleanupErr != nil {
			fmt.Fprintln(os.Stderr, "check: release conformance lock:", cleanupErr)
		}
	}()
	if len(os.Args) < 2 {
		usage()
	}
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	var drivers, dsns listFlag
	fs.Var(&drivers, "driver", "mysql|postgres|sqlite (default mysql); run takes one -driver per -dsn")
	fs.Var(&dsns, "dsn", "bench database DSN URI for every runner (required by run and state)")
	fs.StringVar(&outRoot, "out", "", "run: a directory that does not exist yet; the verified outputs go to it (MySQL) and to its postgres and sqlite directories")
	fs.Var(&selected, "vector", "a vector name, repeatable: run, compare and record only the named vectors (the runners' own selection)")
	fs.Parse(os.Args[2:])
	if len(drivers) == 0 {
		drivers = listFlag{"mysql"}
	}
	for _, name := range drivers {
		if name != "mysql" && name != "postgres" && name != "sqlite" {
			must(fmt.Errorf("unsupported database %q", name))
		}
	}
	if len(dsns) > len(drivers) || (len(drivers) > 1 && len(dsns) != len(drivers)) || (len(drivers) > 1 && os.Args[1] != "run") {
		usage()
	}
	driver = drivers[0]
	if len(dsns) > 0 {
		dsn = dsns[0]
	}
	root, err := os.Getwd()
	must(err)
	switch os.Args[1] {
	case "state":
		if dsn == "" {
			usage()
		}
		stateDB, err := openStateDatabase(driver, dsn)
		must(err)
		digest, err := snapshotDatabase(stateDB, driver)
		must(err)
		must(stateDB.Close())
		fmt.Printf("%s state %s\n", driver, digest)
	case "run":
		if len(dsns) != len(drivers) || slices.Contains(dsns, "") || outRoot == "" {
			usage()
		}
		must(newOutputDirectory(outRoot))
		must(lockDatabases(dsns...))
		binaries, err := os.MkdirTemp("", "orm-conformance-runners-")
		must(err)
		defer os.RemoveAll(binaries)
		must(testcase.RunLong("conformance/build", func(c *testcase.Case) error {
			return buildRunners(c, root, binaries)
		}))
		for index := range drivers {
			driver, dsn = drivers[index], dsns[index]
			runDatabase(root)
		}
		must(os.RemoveAll(binaries))
		must(releaseLocks())
	case "compare":
		return compare(root, fs.Args())
	case "record":
		must(recordVerified(root, fs.Args()))
	default:
		usage()
	}
	return 0
}

// newOutputDirectory는 run의 output directory를 만든다. 이미 있으면 거부한다: 이전 실행의 file이 이 실행의
// output으로 읽히지 않게, run은 언제나 빈 자기 directory에 쓴다.
func newOutputDirectory(path string) error {
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("output directory %s already exists; run writes into a new directory of its own so that no earlier output is read as this run's", path)
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.MkdirAll(path, 0o755)
}

// runDatabase는 driver와 dsn의 database에서 네 runner를 두 번씩 실행해 state를 확인하고,
// output을 vector 기대값과 비교한 뒤 검증된 output을 outRoot(MySQL)나 outRoot/<driver>에 남긴다.
func runDatabase(root string) {
	out := filepath.Join(outRoot, driverDir())
	must(os.MkdirAll(out, 0o755))
	pending, err := os.MkdirTemp(out, ".run-")
	must(err)
	stateDB, err := openStateDatabase(driver, dsn)
	must(err)
	for _, language := range requiredLanguages {
		first := filepath.Join(pending, language+".json")
		repeated := filepath.Join(pending, language+".repeat.json")
		must(testcase.Run("conformance/"+driver+"/"+language, languageDeadline, func(c *testcase.Case) error {
			return runLanguage(c, stateDB, root, language, first, repeated)
		}))
		must(os.Remove(repeated))
	}
	must(stateDB.Close())
	var files []string
	for _, l := range requiredLanguages {
		files = append(files, filepath.Join(pending, l+".json"))
	}
	must(testcase.Run("conformance/"+driver+"/compare", compareDeadline, func(*testcase.Case) error {
		if compare(root, files) != 0 {
			return fmt.Errorf("conformance comparison failed; output retained in %s", pending)
		}
		return nil
	}))
	for _, language := range requiredLanguages {
		must(os.Rename(filepath.Join(pending, language+".json"), filepath.Join(out, language+".json")))
	}
	must(os.Remove(pending))
	fmt.Printf("conformance: verified outputs saved in %s\n", out)
}

func runAndCheckState(db *sql.DB, database, language, phase string, run func() error) error {
	before, err := snapshotDatabase(db, database)
	if err != nil {
		return err
	}
	counters, err := readCounters(db, database)
	if err != nil {
		return err
	}
	runErr := run()
	restoreErr := restoreCounters(db, database, counters)
	after, snapshotErr := snapshotDatabase(db, database)
	var stateErr error
	if snapshotErr == nil && before != after {
		stateErr = fmt.Errorf("%s changed %s database state on %s run", language, database, phase)
	}
	return errors.Join(runErr, restoreErr, snapshotErr, stateErr)
}

// lockPath는 bench database 하나를 쓰는 동안 잡는 lock file이다. runner가 database에 쓰고 되돌리므로 같은
// database를 쓰는 두 실행만 겹치면 안 된다. 이름은 DSN의 hash다. lock은 file의 flock이라 lock을 가진 process가
// 어떻게 끝나든 운영체제가 풀므로, 끝난 실행의 lock이 다음 실행을 막지 않는다. file은 임시 directory에 둔다:
// check runner의 단계에서는 그 단계의 것이므로, kill된 실행의 file도 단계와 함께 지워진다.
func lockPath(dsn string) string {
	sum := sha256.Sum256([]byte(dsn))
	return filepath.Join(os.TempDir(), "orm-conformance-"+hex.EncodeToString(sum[:8])+".lock")
}

// heldLock은 이 process가 가진 lock file과 그 열린 file이다.
type heldLock struct {
	path string
	file *os.File
}

// held는 이 process가 잡은 lock이다. run이 끝날 때 놓는다.
var held []heldLock

// lockDatabases는 dsns의 database마다 lock을 잡는다. 다른 process가 가진 lock이 있으면 기다리지 않고 그 pid와
// 함께 실패한다.
func lockDatabases(dsns ...string) error {
	for _, value := range dsns {
		path := lockPath(value)
		if slices.ContainsFunc(held, func(h heldLock) bool { return h.path == path }) {
			continue
		}
		file, err := lockFile(path)
		if err != nil {
			return err
		}
		held = append(held, heldLock{path, file})
	}
	return nil
}

// lockFile은 path의 flock을 잡는다. lock을 놓는 process는 file을 지운 뒤 놓으므로, 잡은 뒤에 path가 아직 그
// file인지 보고 아니면 다시 연다.
func lockFile(path string) (*os.File, error) {
	for {
		file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
		if err != nil {
			return nil, err
		}
		if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			holder, _ := os.ReadFile(path)
			file.Close()
			if errors.Is(err, syscall.EWOULDBLOCK) {
				return nil, fmt.Errorf("another conformance run (%s) holds %s", strings.TrimSpace(string(holder)), path)
			}
			return nil, fmt.Errorf("lock %s: %w", path, err)
		}
		opened, openErr := file.Stat()
		named, nameErr := os.Stat(path)
		if openErr != nil || nameErr != nil || !os.SameFile(opened, named) {
			file.Close()
			if openErr != nil {
				return nil, openErr
			}
			continue
		}
		if err := file.Truncate(0); err != nil {
			file.Close()
			return nil, err
		}
		if _, err := file.WriteAt([]byte(fmt.Sprintf("pid %d\n", os.Getpid())), 0); err != nil {
			file.Close()
			return nil, err
		}
		return file, nil
	}
}

// releaseLocks는 lock file을 지우고 lock을 놓는다.
func releaseLocks() error {
	var errs []error
	for _, h := range held {
		errs = append(errs, os.Remove(h.path), h.file.Close())
	}
	held = nil
	return errors.Join(errs...)
}

func driverDir() string {
	if driver == "mysql" {
		return ""
	}
	return driver
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: check state -dsn x [-driver d] | check run -out <new dir> [-driver d] -dsn x [-driver d -dsn x]... | check compare|record [-driver d] <go.json> <php.json> <rust.json> <typescript.json>")
	panic(exitCode(2))
}

// must는 err가 있으면 run을 끝낸다(failure). case 안에서 부르면 testcase가 그 case의 FAIL 줄로 보고한다.
func must(err error) {
	if err != nil {
		panic(failure{err})
	}
}

// runLanguage는 한 언어의 runner를 두 번 실행해 매번 database state가 그대로인지 확인하고
// 두 output이 같은지 비교한다.
func runLanguage(c *testcase.Case, stateDB *sql.DB, root, language, first, repeated string) error {
	c.Step("first run")
	if err := runAndCheckState(stateDB, driver, language, "first", func() error { return runOne(c, root, first, language) }); err != nil {
		return err
	}
	c.Step("repeated run")
	if err := runAndCheckState(stateDB, driver, language, "repeated", func() error { return runOne(c, root, repeated, language) }); err != nil {
		return err
	}
	c.Step("compare the two outputs")
	return compareRepeatedEvidence(first, repeated)
}

// goRunner와 rustRunner는 buildRunners가 build한 Go runner와, buildRustRunner가 directory로 복사한 Rust
// runner다.
var goRunner, rustRunner string

// buildRustRunner는 Rust runner를 공유 Rust target directory의 exclusive lease(LEASE, CARGO_LEASES, --wait)
// 아래에서 build하고, 그 lease 안에서 directory로 복사한다(scripts/cargo-build-copy.sh). 실행은 그 복사본을
// 쓰므로 이 checkout의 다른 실행의 build가 target directory를 바꿔도 이 실행의 runner는 바뀌지 않는다.
func buildRustRunner(c *testcase.Case, root, directory string) error {
	lease, leases := os.Getenv("LEASE"), os.Getenv("CARGO_LEASES")
	if lease == "" || leases == "" {
		return fmt.Errorf("LEASE and CARGO_LEASES are unset; run this through make, which exports them")
	}
	if err := runCommand(c, root, "", 0, lease, "run", leases, "exclusive", "--wait", "--", "sh", filepath.Join(root, "scripts", "cargo-build-copy.sh"), directory, "debug/conformance", "--",
		"cargo", "build", "--locked", "--manifest-path", "clients/rust/Cargo.toml", "-p", "polyspec-orm-tests", "--bin", "conformance"); err != nil {
		return err
	}
	rustRunner = filepath.Join(directory, "debug", "conformance")
	return nil
}

// buildRunners는 Rust runner, TypeScript client와 Go runner를 한 번 build한다. Go runner와 Rust runner는
// directory에 binary로 남는다.
func buildRunners(c *testcase.Case, root, directory string) error {
	if err := buildRustRunner(c, root, directory); err != nil {
		return err
	}
	if err := runCommand(c, root, "", 0, "npm", "run", "build", "--prefix", "clients/typescript"); err != nil {
		return err
	}
	binary := filepath.Join(directory, "runner_go")
	if err := runCommand(c, root, "", 0, "go", "build", "-o", binary, "./tests/conformance/runner_go"); err != nil {
		return err
	}
	goRunner = binary
	return nil
}

func runOne(c *testcase.Case, root, output, language string) error {
	flags := []string{"--dsn", dsn}
	goFlags := []string{"-dsn", dsn}
	for _, name := range selected {
		flags = append(flags, "--vector", name)
		goFlags = append(goFlags, "-vector", name)
	}
	switch language {
	case "go":
		if goRunner == "" {
			return fmt.Errorf("go runner is not built")
		}
		return runCommand(c, root, output, runnerDeadline, goRunner, goFlags...)
	case "php":
		return runCommand(c, root, output, runnerDeadline, "php", append([]string{"tests/conformance/runner.php"}, flags...)...)
	case "typescript":
		return runCommand(c, root, output, runnerDeadline, "node", append([]string{"tests/conformance/runner_typescript.mjs"}, flags...)...)
	case "rust":
		if rustRunner == "" {
			return fmt.Errorf("rust runner is not built")
		}
		return runCommand(c, root, output, runnerDeadline, rustRunner, flags...)
	default:
		return fmt.Errorf("unsupported language %q", language)
	}
}

// runCommand는 명령 하나를 timeout과 case c의 기한 가운데 먼저 오는 것 안에 실행하고, 시작을
// c의 단계로 출력한다. timeout이 0이면 장기 작업(build)이므로 timeout을 두지 않는다.
func runCommand(c *testcase.Case, root, output string, timeout time.Duration, name string, args ...string) error {
	ctx, cancel := context.WithCancel(c.Context())
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(c.Context(), timeout)
	}
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = root
	// 명령의 진행 출력(cargo의 Compiling 줄, runner의 log)은 경과 시간과 함께 case의 단계로 보인다.
	steps := c.StepWriter()
	cmd.Stderr = steps
	var buf bytes.Buffer
	if output == "" {
		cmd.Stdout = steps
	} else {
		cmd.Stdout = &buf
	}
	c.Step("run %s", displayCommand(cmd.Args))
	err := cmd.Run()
	steps.Flush()
	if ctx.Err() != nil {
		return fmt.Errorf("%s: %w", name, ctx.Err())
	}
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	if output != "" {
		return os.WriteFile(output, buf.Bytes(), 0o644)
	}
	return nil
}

func displayCommand(args []string) string {
	visible := append([]string(nil), args...)
	for i := 1; i < len(visible); i++ {
		if visible[i-1] == "--dsn" || visible[i-1] == "-dsn" {
			visible[i] = "<redacted>"
		}
	}
	return strings.Join(visible, " ")
}

func validateOutputFiles(outputs []string) error {
	if len(outputs) != len(requiredLanguages) {
		return fmt.Errorf("conformance requires %d language outputs, got %d", len(requiredLanguages), len(outputs))
	}
	want := map[string]bool{}
	for _, language := range requiredLanguages {
		want[language] = true
	}
	for _, output := range outputs {
		language := strings.TrimSuffix(filepath.Base(output), ".json")
		if filepath.Ext(output) != ".json" || !want[language] {
			return fmt.Errorf("duplicate or unknown language output %q", output)
		}
		delete(want, language)
	}
	return nil
}

func compareRepeatedEvidence(first, second string) error {
	a, err := os.ReadFile(first)
	if err != nil {
		return err
	}
	b, err := os.ReadFile(second)
	if err != nil {
		return err
	}
	equal, err := equalJSON(a, b)
	if err != nil {
		return err
	}
	if !equal {
		return fmt.Errorf("conformance output changed between runs: %s", first)
	}
	return nil
}

func decodeExact(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := readJSONValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("multiple JSON values")
		}
		return nil, err
	}
	return value, nil
}

func readJSONValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return token, nil
	}
	switch delimiter {
	case '{':
		object := map[string]any{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, fmt.Errorf("JSON object key is not text")
			}
			if _, exists := object[key]; exists {
				return nil, fmt.Errorf("duplicate JSON object key %q", key)
			}
			object[key], err = readJSONValue(decoder)
			if err != nil {
				return nil, err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if end != json.Delim('}') {
			return nil, fmt.Errorf("JSON object ended with %v", end)
		}
		return object, nil
	case '[':
		array := []any{}
		for decoder.More() {
			item, err := readJSONValue(decoder)
			if err != nil {
				return nil, err
			}
			array = append(array, item)
		}
		end, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if end != json.Delim(']') {
			return nil, fmt.Errorf("JSON array ended with %v", end)
		}
		return array, nil
	default:
		return nil, fmt.Errorf("unexpected JSON delimiter %q", delimiter)
	}
}

type exactNumber struct{ value string }

func normalizeExact(value any) (any, error) {
	switch typed := value.(type) {
	case json.Number:
		rational, ok := new(big.Rat).SetString(string(typed))
		if !ok {
			return nil, fmt.Errorf("invalid JSON number %q", typed)
		}
		return exactNumber{rational.RatString()}, nil
	case []any:
		result := make([]any, len(typed))
		for i, item := range typed {
			var err error
			result[i], err = normalizeExact(item)
			if err != nil {
				return nil, err
			}
		}
		return result, nil
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			var err error
			result[key], err = normalizeExact(item)
			if err != nil {
				return nil, err
			}
		}
		return result, nil
	default:
		return value, nil
	}
}

func equalJSON(a, b []byte) (bool, error) {
	left, err := decodeExact(a)
	if err != nil {
		return false, err
	}
	right, err := decodeExact(b)
	if err != nil {
		return false, err
	}
	left, err = normalizeExact(left)
	if err != nil {
		return false, err
	}
	right, err = normalizeExact(right)
	if err != nil {
		return false, err
	}
	return reflect.DeepEqual(left, right), nil
}

// load reads the vector list (names and chains) from vectors.json — the single
// place a vector is declared — and, for another database, overlays the
// expectations recorded for that dialect (vectors.<driver>.json).
func load(root string) (file, error) {
	basePath := filepath.Join(root, "tests/conformance/vectors.json")
	b, err := os.ReadFile(basePath)
	if err != nil {
		return file{}, err
	}
	if _, err := decodeExact(b); err != nil {
		return file{}, fmt.Errorf("%s: %w", basePath, err)
	}
	var f file
	if err := json.Unmarshal(b, &f); err != nil {
		return file{}, fmt.Errorf("%s: %w", basePath, err)
	}
	declared, err := vectorNames(f.Vectors, basePath)
	if err != nil {
		return file{}, err
	}
	if driver == "mysql" {
		return f, nil
	}
	dialectPath := filepath.Join(root, vectorsPath())
	b, err = os.ReadFile(dialectPath)
	if err != nil {
		return file{}, err
	}
	if _, err := decodeExact(b); err != nil {
		return file{}, fmt.Errorf("%s: %w", dialectPath, err)
	}
	var d file
	if err := json.Unmarshal(b, &d); err != nil {
		return file{}, fmt.Errorf("%s: %w", dialectPath, err)
	}
	recorded, err := vectorNames(d.Vectors, dialectPath)
	if err != nil {
		return file{}, err
	}
	for name := range recorded {
		if _, ok := declared[name]; !ok {
			return file{}, fmt.Errorf("%s: undeclared vector %s", dialectPath, name)
		}
	}
	for i := range f.Vectors {
		v, ok := recorded[f.Vectors[i].Name]
		if !ok {
			return file{}, fmt.Errorf("%s: missing vector %s", dialectPath, f.Vectors[i].Name)
		}
		f.Vectors[i].Expect = v.Expect
	}
	return f, nil
}

func vectorNames(vectors []vec, path string) (map[string]vec, error) {
	if len(vectors) == 0 {
		return nil, fmt.Errorf("%s: no vectors", path)
	}
	names := make(map[string]vec, len(vectors))
	for _, v := range vectors {
		if v.Name == "" {
			return nil, fmt.Errorf("%s: empty vector name", path)
		}
		if _, exists := names[v.Name]; exists {
			return nil, fmt.Errorf("%s: duplicate vector %s", path, v.Name)
		}
		names[v.Name] = v
	}
	return names, nil
}

// describeDifference는 vector 기대값과 output의 차이를 적는다: 다른 result는 두 값을, statement는 더해지거나
// 빠진 statement를 그 위치, kind, SQL, binds, error와 함께(internal/stmtdiff), 그 밖의 다른 field는 두 값을.
func describeDifference(want, got json.RawMessage) []string {
	var expected, actual map[string]json.RawMessage
	if json.Unmarshal(want, &expected) != nil || json.Unmarshal(got, &actual) != nil {
		return []string{"expected " + canon(want), "got " + canon(got)}
	}
	var lines []string
	keys := map[string]bool{}
	for key := range expected {
		keys[key] = true
	}
	for key := range actual {
		keys[key] = true
	}
	names := make([]string, 0, len(keys))
	for key := range keys {
		names = append(names, key)
	}
	slices.Sort(names)
	for _, key := range names {
		e, inExpected := expected[key]
		a, inActual := actual[key]
		switch {
		case !inExpected:
			lines = append(lines, fmt.Sprintf("%s: not expected, got %s", key, canon(a)))
		case !inActual:
			lines = append(lines, fmt.Sprintf("%s: missing, expected %s", key, canon(e)))
		case key == "statements":
			changes, err := statementChanges(e, a)
			if err != nil {
				lines = append(lines, fmt.Sprintf("statements: %v; expected %s, got %s", err, canon(e), canon(a)))
				continue
			}
			if len(changes) == 0 {
				continue
			}
			lines = append(lines, fmt.Sprintf("statements: %s", stmtdiff.Summary(changes, stmtdiff.Group)))
			for _, change := range changes {
				lines = append(lines, "  "+change.String())
			}
		default:
			if equal, err := equalJSON(e, a); err != nil || !equal {
				lines = append(lines, fmt.Sprintf("%s: expected %s, got %s", key, compact(e), compact(a)))
			}
		}
	}
	return lines
}

// statementChanges는 두 statement 목록의 차이다. statement 하나의 비교 기준은 정렬된 key의 JSON 전체다.
func statementChanges(want, got json.RawMessage) ([]stmtdiff.Change, error) {
	convert := func(raw json.RawMessage) ([]stmtdiff.Statement, error) {
		var list []json.RawMessage
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, fmt.Errorf("not a statement list: %w", err)
		}
		out := make([]stmtdiff.Statement, len(list))
		for index, item := range list {
			var fields struct {
				Kind  string          `json:"kind"`
				SQL   string          `json:"sql"`
				Binds json.RawMessage `json:"binds"`
				Error json.RawMessage `json:"error"`
			}
			if err := json.Unmarshal(item, &fields); err != nil {
				return nil, fmt.Errorf("statement %d: %w", index+1, err)
			}
			text := fmt.Sprintf("%s binds %s", fields.SQL, compact(fields.Binds))
			if len(fields.Error) > 0 && string(fields.Error) != "null" {
				text += " error " + compact(fields.Error)
			}
			out[index] = stmtdiff.Statement{Kind: fields.Kind, Text: text, Key: compact(item)}
		}
		return out, nil
	}
	expected, err := convert(want)
	if err != nil {
		return nil, err
	}
	actual, err := convert(got)
	if err != nil {
		return nil, err
	}
	return stmtdiff.Diff(expected, actual), nil
}

// compact는 JSON을 정렬된 key의 한 줄로 적는다.
func compact(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "null"
	}
	v, err := decodeExact(raw)
	if err != nil {
		return string(raw)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return string(raw)
	}
	return string(b)
}

// canon re-encodes JSON with sorted keys and without changing number precision.
func canon(raw json.RawMessage) string {
	v, err := decodeExact(raw)
	must(err)
	b, err := json.MarshalIndent(v, "", "  ")
	must(err)
	return string(b)
}

func compare(root string, outputs []string) int {
	if err := validateOutputFiles(outputs); err != nil {
		fmt.Fprintln(os.Stderr, "check:", err)
		return 1
	}
	f, err := load(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "check:", err)
		return 1
	}
	type got map[string]json.RawMessage
	langs := []string{}
	results := map[string]got{}
	for _, p := range outputs {
		lang := strings.TrimSuffix(filepath.Base(p), ".json")
		b, err := os.ReadFile(p)
		must(err)
		_, err = decodeExact(b)
		must(err)
		var g got
		must(json.Unmarshal(b, &g))
		langs = append(langs, lang)
		results[lang] = g
	}
	failed := 0
	declared := map[string]bool{}
	compared := 0
	for _, v := range f.Vectors {
		declared[v.Name] = true
		if !chosen(v.Name) {
			continue
		}
		compared++
		if len(v.Expect) == 0 || string(v.Expect) == "null" {
			fmt.Printf("%-22s (no expectation recorded)\n", v.Name)
			failed++
			continue
		}
		line := fmt.Sprintf("%-22s", v.Name)
		var diffs []string
		for _, lang := range langs {
			g, ok := results[lang][v.Name]
			if !ok {
				line += fmt.Sprintf(" %s:MISSING", lang)
				failed++
				continue
			}
			equal, err := equalJSON(g, v.Expect)
			must(err)
			if !equal {
				line += fmt.Sprintf(" %s:DIFF", lang)
				failed++
				diffs = append(diffs, fmt.Sprintf("--- %s: %s output differs from %s\n%s\n", v.Name, lang, vectorsPath(), strings.Join(describeDifference(v.Expect, g), "\n")))
			} else {
				line += fmt.Sprintf(" %s:ok", lang)
			}
		}
		fmt.Println(line)
		for _, d := range diffs {
			fmt.Print(d)
		}
	}
	for _, lang := range langs {
		for name := range results[lang] {
			if !declared[name] {
				fmt.Printf("%-22s %s:UNDECLARED\n", name, lang)
				failed++
			}
		}
	}
	if failed == 0 {
		fmt.Printf("conformance: %d vectors × %d languages identical\n", compared, len(langs))
		return 0
	}
	fmt.Printf("conformance: %d mismatches\n", failed)
	return 1
}

func recordVerified(root string, outputs []string) error {
	if err := validateOutputFiles(outputs); err != nil {
		return err
	}
	f, err := load(root)
	if err != nil {
		return err
	}
	results := make(map[string]map[string]json.RawMessage, len(outputs))
	for _, output := range outputs {
		b, err := os.ReadFile(output)
		if err != nil {
			return err
		}
		if _, err := decodeExact(b); err != nil {
			return fmt.Errorf("%s: %w", output, err)
		}
		var values map[string]json.RawMessage
		if err := json.Unmarshal(b, &values); err != nil {
			return fmt.Errorf("%s: %w", output, err)
		}
		results[strings.TrimSuffix(filepath.Base(output), ".json")] = values
	}
	goResults := results["go"]
	declared := make(map[string]bool, len(f.Vectors))
	for i := range f.Vectors {
		name := f.Vectors[i].Name
		declared[name] = true
		if !chosen(name) {
			continue
		}
		r, ok := goResults[name]
		if !ok {
			return fmt.Errorf("vector %s missing from go output", name)
		}
		for _, language := range requiredLanguages[1:] {
			other, ok := results[language][name]
			if !ok {
				return fmt.Errorf("vector %s missing from %s output", name, language)
			}
			equal, err := equalJSON(r, other)
			if err != nil {
				return fmt.Errorf("vector %s in %s output: %w", name, language, err)
			}
			if !equal {
				return fmt.Errorf("vector %s differs between go and %s outputs", name, language)
			}
		}
		f.Vectors[i].Expect = json.RawMessage(canon(r))
	}
	for _, language := range requiredLanguages {
		for name := range results[language] {
			if !declared[name] {
				return fmt.Errorf("%s output has undeclared vector %q", language, name)
			}
		}
	}
	out, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(root, vectorsPath())
	temporary, err := os.CreateTemp(filepath.Dir(path), ".vectors-")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if err := temporary.Chmod(0o644); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(out, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary.Name(), path); err != nil {
		return err
	}
	fmt.Printf("recorded %d agreed vectors into %s\n", len(f.Vectors), vectorsPath())
	return nil
}
