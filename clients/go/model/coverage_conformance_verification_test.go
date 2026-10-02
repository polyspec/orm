//go:build featurecoverage

package model_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
)

// TestCoverageConformanceVector는 Go conformance runner가 고른 database에서
// 읽기 전용 vector conditions_values와 relations만 실행하고, 각 출력이 그
// database의 기록된 expect와 JSON 값으로 같은지 확인한다.
func TestCoverageConformanceVector(t *testing.T) {
	driver, dsn := featureDatabase(t)
	root := filepath.Join("..", "..", "..")
	names := []string{"conditions_values", "relations"}
	expectFile := map[string]string{
		"mysql":    "vectors.json",
		"postgres": "vectors.postgres.json",
		"sqlite":   "vectors.sqlite.json",
	}[driver]
	raw, err := os.ReadFile(filepath.Join(root, "tests", "conformance", expectFile))
	if err != nil {
		t.Fatal(err)
	}
	var recorded struct {
		Vectors []struct {
			Name   string `json:"name"`
			Expect any    `json:"expect"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &recorded); err != nil {
		t.Fatalf("%s: %v", expectFile, err)
	}
	expect := map[string]any{}
	for _, v := range recorded.Vectors {
		if slices.Contains(names, v.Name) {
			if _, seen := expect[v.Name]; seen || v.Expect == nil {
				t.Fatalf("%s: vector %s is repeated or has no expect", expectFile, v.Name)
			}
			expect[v.Name] = v.Expect
		}
	}

	cmd := exec.Command("go", "run", "./tests/conformance/runner_go", "-dsn", dsn, "-vector", names[0], "-vector", names[1])
	cmd.Dir = root
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("runner_go: %v\n%s", err, bytes.ReplaceAll(stderr.Bytes(), []byte(dsn), []byte("[redacted]")))
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("runner_go output: %v", err)
	}
	if len(output) != len(names) {
		t.Fatalf("runner_go printed %d vectors, want %v", len(output), names)
	}
	for _, name := range names {
		want, ok := expect[name]
		if !ok {
			t.Fatalf("%s has no vector %s", expectFile, name)
		}
		got, ok := output[name]
		if !ok {
			t.Fatalf("runner_go did not print vector %s", name)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("vector %s on %s:\n got %v\nwant %v", name, driver, got, want)
		}
	}
}
