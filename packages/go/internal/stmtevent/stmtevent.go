// Package stmtevent is the statement event record of docs/operations/usage.md
// "Statement events", as the conformance vectors and the ORM tests write it.
package stmtevent

// Record is one statement event. Transaction is the number counted from 1 again
// in order of first appearance within the vector, and null outside one. Error is
// the error code of the statement, or null.
type Record struct {
	SQL         string   `json:"sql"`
	Binds       []any    `json:"binds"`
	Kind        string   `json:"kind"`
	Tables      []string `json:"tables"`
	Transaction *int64   `json:"transaction"`
	Error       *string  `json:"error"`
}
