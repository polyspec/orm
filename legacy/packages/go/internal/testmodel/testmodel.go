// Package testmodel loads the runtime model of a dbspec document for the tests
// of the engine and the generator.
package testmodel

import (
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
)

// Load returns the runtime model of one dbspec document; a document with
// diagnostics fails the test.
func Load(t testing.TB, document string) *runtimemodel.Model {
	t.Helper()
	m, diagnostics := runtimemodel.LoadDocuments([]string{document})
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	return m
}
