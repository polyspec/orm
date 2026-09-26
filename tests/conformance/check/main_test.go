package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRecordRequiresFourEqualOutputs(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "tests", "conformance")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	vectors := filepath.Join(directory, "vectors.json")
	before := []byte(`{"vectors":[{"name":"one","chain":"one","expect":{"result":0}}]}`)
	if err := os.WriteFile(vectors, before, 0o600); err != nil {
		t.Fatal(err)
	}
	var outputs []string
	for _, language := range requiredLanguages {
		output := filepath.Join(root, language+".json")
		if err := os.WriteFile(output, []byte(`{"one":{"result":1}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		outputs = append(outputs, output)
	}
	previousDriver := driver
	driver = "mysql"
	t.Cleanup(func() { driver = previousDriver })
	for _, incomplete := range [][]string{outputs[:3], outputs[1:]} {
		if err := recordVerified(root, incomplete); err == nil {
			t.Fatal("record accepted incomplete client evidence")
		}
		assertFileEquals(t, vectors, before)
	}
	if err := os.WriteFile(outputs[1], []byte(`{"one":{"result":2}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := recordVerified(root, outputs); err == nil {
		t.Fatal("record accepted conflicting client results")
	}
	assertFileEquals(t, vectors, before)
	for _, invalid := range []string{
		`{}`,
		`{"one":{"result":1},"extra":{"result":1}}`,
	} {
		if err := os.WriteFile(outputs[1], []byte(invalid), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := recordVerified(root, outputs); err == nil {
			t.Fatalf("record accepted an incomplete or undeclared vector: %s", invalid)
		}
		assertFileEquals(t, vectors, before)
	}
	if err := os.WriteFile(outputs[1], []byte(`{"one":{"result":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := recordVerified(root, outputs); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(vectors)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), `"result": 1`) {
		t.Fatalf("record did not save the agreed result: %s", got)
	}
}

func assertFileEquals(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("record changed expectations after rejecting evidence: %s", got)
	}
}

func TestCompleteLanguageEvidence(t *testing.T) {
	dir := t.TempDir()
	all := []string{}
	for _, name := range []string{"go", "php", "rust", "typescript"} {
		all = append(all, filepath.Join(dir, name+".json"))
	}
	if err := validateOutputFiles(all); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name  string
		files []string
	}{
		{"missing client", all[:3]},
		{"duplicate client", append(append([]string{}, all...), all[0])},
		{"unknown client", append(append([]string{}, all[:3]...), filepath.Join(dir, "other.json"))},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := validateOutputFiles(test.files); err == nil {
				t.Fatal("incomplete language evidence accepted")
			}
		})
	}
}

func TestRepeatedEvidenceRejectsChangedOutput(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first.json")
	second := filepath.Join(dir, "second.json")
	if err := os.WriteFile(first, []byte(`{"one":{"result":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte(`{"one":{"result":2}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := compareRepeatedEvidence(first, second); err == nil {
		t.Fatal("changed result accepted as repeatable")
	}
	if err := os.WriteFile(second, []byte(`{"one":{"result":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := compareRepeatedEvidence(first, second); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(first, []byte(`{"one":{"result":9007199254740992}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte(`{"one":{"result":9007199254740993}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := compareRepeatedEvidence(first, second); err == nil {
		t.Fatal("distinct large integers accepted as repeatable")
	}
}

func TestExactNumericConformance(t *testing.T) {
	for _, test := range []struct {
		left, right string
		equal       bool
	}{
		{`{"value":9007199254740992}`, `{"value":9007199254740993}`, false},
		{`{"value":48000}`, `{"value":48000.0}`, true},
		{`{"value":9.007199254740993e15}`, `{"value":9007199254740993}`, true},
	} {
		got, err := equalJSON([]byte(test.left), []byte(test.right))
		if err != nil || got != test.equal {
			t.Fatalf("compare %s and %s: equal=%t, error=%v", test.left, test.right, got, err)
		}
	}
	if got := canon([]byte(`{"value":9007199254740993}`)); got != "{\n  \"value\": 9007199254740993\n}" {
		t.Fatalf("recording rounded a large integer: %s", got)
	}
}

func TestDuplicateJSONKeysFail(t *testing.T) {
	for _, raw := range []string{
		`{"vector":{"result":1},"vector":{"result":2}}`,
		`{"vector":{"result":{"field":1,"field":2}}}`,
	} {
		if _, err := decodeExact([]byte(raw)); err == nil {
			t.Fatalf("duplicate JSON key was silently discarded: %s", raw)
		}
	}
}

func TestRunRemovesStaleVerifiedOutputs(t *testing.T) {
	dir := t.TempDir()
	for _, language := range requiredLanguages {
		if err := os.WriteFile(filepath.Join(dir, language+".json"), []byte(`{}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := removeVerifiedOutputs(dir); err != nil {
		t.Fatal(err)
	}
	for _, language := range requiredLanguages {
		if _, err := os.Stat(filepath.Join(dir, language+".json")); !os.IsNotExist(err) {
			t.Fatalf("stale %s output remained: %v", language, err)
		}
	}
}

func TestRunnerDeadlineFails(t *testing.T) {
	if err := runCommand(t.TempDir(), "", 20*time.Millisecond, "/bin/sleep", "1"); err == nil {
		t.Fatal("timed-out runner reported success")
	}
}

func TestCommandLogDoesNotExposeDSN(t *testing.T) {
	for _, flag := range []string{"--dsn", "-dsn"} {
		got := displayCommand([]string{"runner", flag, "mysql://user:secret@db/test", "schema.json"})
		want := "runner " + flag + " <redacted> schema.json"
		if got != want {
			t.Fatalf("DSN was exposed or command arguments changed: %q", got)
		}
	}
}
