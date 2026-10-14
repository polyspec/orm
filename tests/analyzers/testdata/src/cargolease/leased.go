package cargolease

import "os/exec"

const lease = "lease"

func leased() error {
	args := []string{"run", "leases", "exclusive", "--wait", "--", "node", "scripts/cargo-build-copy.mts", "--", "cargo", "test", "--no-run"}
	return exec.Command(lease, args...).Run()
}

// The words cargo and build apart, or in a comment ("cargo", "build"), run nothing.
func apart() []string { return []string{"cargo", "--version", "build"} }
