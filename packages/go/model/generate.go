// Package model holds the Go models generated from contracts/fixtures/bench/bench.dbs for the
// repository's tests, examples, and benchmarks.
package model

//go:generate go run ../cmd/orm-gen gen --set ../../../contracts/fixtures/bench/dbspec-set.json --lang go --out . --scan ./... --scan ../../../tests/conformance/runner_go --scan ../../../examples/... --scan ../bench
