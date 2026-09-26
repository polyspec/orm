package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

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
	got := displayCommand([]string{"runner", "--dsn", "mysql://user:secret@db/test", "schema.json"})
	if got != "runner --dsn <redacted> schema.json" {
		t.Fatalf("DSN was exposed or command arguments changed: %q", got)
	}
}
