package cargolease

import "os/exec"

func build() error {
	return exec.Command("cargo", "build", "--locked").Run() // want `runs cargo without the lease of the shared Rust target directory and a copy of its program; run it through lease run and scripts/cargo-build-copy.mts`
}
