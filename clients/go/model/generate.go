// Package model holds the Go models generated from schema/bench.dbspec for the
// repository's tests, examples, and benchmarks.
package model

//go:generate go run ../../../cmd/orm-gen gen --document ../../../schema/bench.dbspec --lang go --out . --scan ./... --scan ../../../tests/conformance/runner_go --scan ../../../examples/... --scan ../../../bench/go
