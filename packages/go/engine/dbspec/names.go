package dbspec

import (
	"crypto/sha256"
	"encoding/hex"
)

// The renderer names of CHECKs, triggers and functions (docs/dbspec.md
// "Names"): the plain form <table>$<suffix> when it has at most maxNameBytes,
// otherwise its first 54 bytes, a $ and the first 8 lowercase hexadecimal
// digits of its SHA-256, 54 + 1 + 8 = 63 bytes.
const (
	renderedHashDigits  = 8
	renderedPrefixBytes = maxNameBytes - 1 - renderedHashDigits
)

// rendererName returns the name that the renderer writes for the suffix of
// table, a column or an event.
func rendererName(table, suffix string) string {
	plain := table + "$" + suffix
	if len(plain) <= maxNameBytes {
		return plain
	}
	sum := sha256.Sum256([]byte(plain))
	return plain[:renderedPrefixBytes] + "$" + hex.EncodeToString(sum[:])[:renderedHashDigits]
}

// renderedColumn returns the column of columns whose renderer name is name,
// recomputing the name of each column, so a name read from a database is
// matched exactly and never split on $ (docs/dbspec.md "Names").
func renderedColumn[V any](table, name string, columns map[string]V) (string, bool) {
	for column := range columns {
		if rendererName(table, column) == name {
			return column, true
		}
	}
	return "", false
}
