package callerpath

import "runtime"

func root() string {
	_, file, _, _ := runtime.Caller(0) // want `runtime.Caller gives the path the binary was compiled at, not the checkout that runs it`
	return file
}

func stack() int {
	return runtime.Callers(0, nil) // want `runtime.Callers gives the path the binary was compiled at`
}

// runtime.Caller(0) in a comment is no use, and a string is not either.
func named() string { return "runtime.Caller(0)" }

// Another function of package runtime is fine.
func processors() int { return runtime.NumCPU() }
