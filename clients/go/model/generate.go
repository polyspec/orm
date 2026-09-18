// Package model holds the Go models generated from schema/schema.json for the
// repository's tests, examples, and benchmarks.
package model

//go:generate go run ../../../cmd/ormgen gen --schema ../../../schema/schema.json --lang go --out . --scan ./... --scan ../../../tests/conformance/runner_go --scan ../../../examples/... --scan ../../../bench/go
