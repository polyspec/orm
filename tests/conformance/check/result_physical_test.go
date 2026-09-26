//go:build physical

package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

var resultRunnerLanguages = []string{"go", "php", "rust", "typescript"}

func TestPhysicalResultRunners(t *testing.T) {
	if !slices.Equal(resultRunnerLanguages, requiredLanguages) {
		t.Fatalf("physical result runners %v differ from required languages %v", resultRunnerLanguages, requiredLanguages)
	}
	if err := os.Mkdir(lockDir, 0o755); err != nil {
		t.Fatalf("conformance database lock: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Remove(lockDir); err != nil {
			t.Error(err)
		}
	})
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	if err := buildRunners(root); err != nil {
		t.Fatal(err)
	}
	for _, database := range []struct{ name, env string }{
		{"mysql", "BENCH_MYSQL_DSN"},
		{"postgres", "BENCH_POSTGRES_DSN"},
		{"sqlite", "BENCH_SQLITE_DSN"},
	} {
		t.Run(database.name, func(t *testing.T) {
			driver, dsn = database.name, os.Getenv(database.env)
			if dsn == "" {
				t.Fatalf("%s is required", database.env)
			}
			stateDB, err := openStateDatabase(driver, dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := stateDB.Close(); err != nil {
					t.Error(err)
				}
			}()
			for _, language := range resultRunnerLanguages {
				t.Run(language, func(t *testing.T) {
					first := filepath.Join(t.TempDir(), "first.json")
					repeated := filepath.Join(t.TempDir(), "repeated.json")
					if err := runAndCheckState(stateDB, driver, language, "first", func() error { return runOne(root, first, language) }); err != nil {
						t.Fatal(err)
					}
					if err := runAndCheckState(stateDB, driver, language, "repeated", func() error { return runOne(root, repeated, language) }); err != nil {
						t.Fatal(err)
					}
					if err := compareRepeatedEvidence(first, repeated); err != nil {
						t.Fatal(err)
					}
				})
			}
		})
	}
}
