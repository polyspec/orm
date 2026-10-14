package deferredexit

import "os"

func leaking() {
	directory, _ := os.MkdirTemp("", "x-")
	defer os.RemoveAll(directory)
	// os.Exit(3) in a comment is not a call
	if failed() {
		os.Exit(1) // want `leaking calls os.Exit after a defer, which then never runs; return the exit code to main and end it with os.Exit\(run\(\)\)`
	}
}

func recovering() {
	defer func() {
		if recover() != nil {
			os.Exit(1) // want `recovering calls os.Exit after a defer`
		}
	}()
}

func helper() {
	db := open()
	defer db.Close()
	check(db.Ping()) // want `helper calls check, which calls os.Exit, after a defer, which then never runs`
}

// main ends with os.Exit(run()), and run returns the exit code: neither calls os.Exit after a defer.
func main() {
	os.Exit(run())
}

func run() int {
	directory, _ := os.MkdirTemp("", "x-")
	defer os.RemoveAll(directory)
	return 1
}

// usage exits before any defer.
func usage() {
	os.Exit(2)
	defer println()
}

func check(err error) {
	if err != nil {
		fail(err)
	}
}

func fail(error) {
	os.Exit(1)
}

// exit is a variable, not a function of the package: calling it is no call of os.Exit by name.
var exit = func(code int) {}

func variable() {
	defer println()
	exit(1)
}

type connection struct{}

func (connection) Close() error { return nil }
func (connection) Ping() error  { return nil }

func open() connection { return connection{} }
func failed() bool     { return false }

// A defer and os.Exit on one line are a defer and a call after it.
func oneLine() { defer println(); os.Exit(1) } // want `oneLine calls os.Exit after a defer`
