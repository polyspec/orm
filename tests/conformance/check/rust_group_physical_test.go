//go:build physical

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

func TestPhysicalRustGroupBoolean(t *testing.T) {
	testcase.Group(t)
	lockBench(t)
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	// build는 장기 작업이므로 기한 없이 실행하고, Rust runner는 이 test의 directory로 복사한다.
	binaries := t.TempDir()
	if err := testcase.RunLong("conformance/rust-build", func(c *testcase.Case) error { return buildRustRunner(c, root, binaries) }); err != nil {
		t.Fatal(err)
	}
	for _, database := range []struct{ name, env string }{
		{"mysql", "BENCH_MYSQL_DSN"},
		{"postgres", "BENCH_POSTGRES_DSN"},
		{"sqlite", "BENCH_SQLITE_DSN"},
	} {
		t.Run(database.name, func(t *testing.T) {
			c := testcase.Start(t, languageDeadline)
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
			first := filepath.Join(t.TempDir(), "first.json")
			repeated := filepath.Join(t.TempDir(), "repeated.json")
			if err := runLanguage(c, stateDB, root, "rust", first, repeated); err != nil {
				t.Fatal(err)
			}
			output, err := os.ReadFile(first)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := decodeExact(output); err != nil {
				t.Fatal(err)
			}
			var got map[string]json.RawMessage
			if err := json.Unmarshal(output, &got); err != nil {
				t.Fatal(err)
			}
			if len(got["aggregates"]) == 0 {
				t.Fatal("Rust runner omitted aggregates")
			}
			path := filepath.Join(root, vectorsPath())
			expected, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := decodeExact(expected); err != nil {
				t.Fatal(err)
			}
			var contract struct {
				Vectors []struct {
					Name   string          `json:"name"`
					Expect json.RawMessage `json:"expect"`
				} `json:"vectors"`
			}
			if err := json.Unmarshal(expected, &contract); err != nil {
				t.Fatal(err)
			}
			for _, vector := range contract.Vectors {
				if vector.Name != "aggregates" {
					continue
				}
				if len(vector.Expect) == 0 || string(vector.Expect) == "null" {
					t.Fatal("aggregates expectation is missing")
				}
				equal, err := equalJSON(got["aggregates"], vector.Expect)
				if err != nil {
					t.Fatal(err)
				}
				if !equal {
					t.Fatalf("Rust aggregates differ from %s expectations", driver)
				}
				return
			}
			t.Fatal("aggregates vector is not declared")
		})
	}
}
