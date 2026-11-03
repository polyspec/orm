package runtimemodel

import (
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestLoadFilesRejectsFileWithoutSignature checks that a file with no signature (a DbSchema project XML,
// an empty file) is rejected, without parsing it, by a single SCHEMA_INVALID signature diagnostic.
// Requirements: DBS-4, DBS-155.
func TestLoadFilesRejectsFileWithoutSignature(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, name := range []string{"dbschema.dbs", "empty.dbs"} {
		path := filepath.Join("..", "..", "..", "..", "tests", "dbspec", "files", name)
		_, err := LoadFiles(path)
		want := "SCHEMA_INVALID: 1:1 signature: " + path + " is not a dbspec document"
		if err == nil || err.Error() != want {
			t.Fatalf("LoadFiles(%s) = %v, want %s", name, err, want)
		}
	}
}
