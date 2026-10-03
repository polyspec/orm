//go:build physical

package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

var resultRunnerLanguages = []string{"go", "php", "rust", "typescript"}

func TestPhysicalResultRunners(t *testing.T) {
	testcase.Group(t)
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
	if !t.Run("build", func(t *testing.T) {
		c := testcase.Start(t, rustBuildDeadline+typescriptBuildDeadline)
		if err := buildRunners(c, root); err != nil {
			t.Fatal(err)
		}
	}) {
		return
	}
	for _, database := range []struct{ name, env string }{
		{"mysql", "BENCH_MYSQL_DSN"},
		{"postgres", "BENCH_POSTGRES_DSN"},
		{"sqlite", "BENCH_SQLITE_DSN"},
	} {
		t.Run(database.name, func(t *testing.T) {
			testcase.Group(t)
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
					c := testcase.Start(t, languageDeadline)
					first := filepath.Join(t.TempDir(), "first.json")
					repeated := filepath.Join(t.TempDir(), "repeated.json")
					if err := runLanguage(c, stateDB, root, language, first, repeated); err != nil {
						t.Fatal(err)
					}
				})
			}
		})
	}
}
