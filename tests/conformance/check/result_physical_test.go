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
	lockBench(t)
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	// build된 Go runner는 언어 case가 모두 끝날 때까지 남아야 하므로 test 전체의 directory에 둔다.
	binaries := t.TempDir()
	// build는 장기 작업이므로 기한 없이 실행한다(testcase.RunLong).
	if err := testcase.RunLong("conformance/build", func(c *testcase.Case) error { return buildRunners(c, root, binaries) }); err != nil {
		t.Fatal(err)
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
				t.Fatalf("%s is required; run the test through its make target, which reads the environment of make test-servers", database.env)
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
