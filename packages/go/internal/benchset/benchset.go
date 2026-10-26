// Package benchset installs the bench set for the tests that use its generated model.
//
// The bench set (contracts/fixtures/bench/dbspec-set.json) uses the table shared_note of its external document
// bench_shared.dbs, which must exist before the set installs (docs/spec/dbspec.md "External documents"), so Install
// installs the external document first as its own set, as scripts/bench-db.mts does, and then the bench set.
package benchset

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
)

// Shared is the schema value of contracts/fixtures/bench/bench_shared.dbs, as the set that owns it would generate it.
func Shared() (*orm.Schema, error) {
	path, err := benchSharedPath()
	if err != nil {
		return nil, err
	}
	text, diagnostics, err := dbspec.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(diagnostics) > 0 {
		return nil, fmt.Errorf("%s: %v", path, diagnostics)
	}
	m, modelDiagnostics := runtimemodel.LoadDocuments([]string{text})
	if len(modelDiagnostics) > 0 {
		return nil, errors.New(runtimemodel.DiagnosticsError(modelDiagnostics))
	}
	return &orm.Schema{Hash: m.ManifestHash, Text: m.ManifestText}, nil
}

// benchSharedPath finds the repository fixture from the working directory, which go test sets to the package directory.
func benchSharedPath() (string, error) {
	directory, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("get working directory: %w", err)
	}
	for {
		path := filepath.Join(directory, "contracts", "fixtures", "bench", "bench_shared.dbs")
		if _, err := os.Stat(path); err == nil {
			return path, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("check bench shared fixture %s: %w", path, err)
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", fmt.Errorf("could not find contracts/fixtures/bench/bench_shared.dbs above working directory %s", directory)
		}
		directory = parent
	}
}

// Install installs the external document of the bench set, then the bench set, on the database of db.
func Install(db *orm.DB) error {
	shared, err := Shared()
	if err != nil {
		return err
	}
	if err := db.Utils().Schema().Install(shared); err != nil {
		return err
	}
	return db.Utils().Schema().Install(model.Schema)
}
