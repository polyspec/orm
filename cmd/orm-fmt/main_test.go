package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// TestCasesRunThroughTheFormatter pins orm-fmt over the shared case database: every canonical
// case is already formatted, every normalize case formats into its canonical text, and every
// invalid case is refused with exit 2, for a parse with diagnostics is never rewritten.
func TestCasesRunThroughTheFormatter(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	b, err := os.ReadFile(filepath.Join("..", "..", "tests", "dbspec", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases struct {
		Canonical []struct {
			ID        string              `json:"id"`
			Documents map[string][]string `json:"documents"`
			Main      string              `json:"main"`
		} `json:"canonical"`
		Normalize []struct {
			ID        string              `json:"id"`
			Documents map[string][]string `json:"documents"`
			Main      string              `json:"main"`
			Canonical []string            `json:"canonical"`
		} `json:"normalize"`
		Invalid []struct {
			ID        string              `json:"id"`
			Documents map[string][]string `json:"documents"`
			Main      string              `json:"main"`
		} `json:"invalid"`
	}
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	for _, group := range []struct {
		name string
		run  func(t *testing.T)
	}{{
		"the canonical cases are formatted",
		func(t *testing.T) {
			for _, c := range cases.Canonical {
				t.Run(c.ID, func(t *testing.T) {
					formatted, err := formatText(join(c.Documents[c.Main]), others(c.Documents, c.Main), c.Main)
					if err != nil {
						t.Fatal(err)
					}
					if formatted != join(c.Documents[c.Main]) {
						t.Fatalf("the canonical case %s formats differently", c.ID)
					}
				})
			}
		},
	}, {
		"the normalize cases format into their canonical text",
		func(t *testing.T) {
			for _, c := range cases.Normalize {
				t.Run(c.ID, func(t *testing.T) {
					formatted, err := formatText(join(c.Documents[c.Main]), others(c.Documents, c.Main), c.Main)
					if err != nil {
						t.Fatal(err)
					}
					if formatted != join(c.Canonical) {
						t.Fatalf("the case %s formats into\n%s\nwant\n%s", c.ID, formatted, c.Canonical)
					}
				})
			}
		},
	}, {
		"the invalid cases are refused",
		func(t *testing.T) {
			for _, c := range cases.Invalid {
				t.Run(c.ID, func(t *testing.T) {
					if _, err := formatText(join(c.Documents[c.Main]), others(c.Documents, c.Main), c.Main); err == nil {
						t.Fatalf("the invalid case %s formats", c.ID)
					}
				})
			}
		},
	}} {
		t.Run(group.name, group.run)
	}
}

// others returns the document set without the main document, as Parse wants it.
func others(documents map[string][]string, main string) map[string]string {
	set := make(map[string]string, len(documents)-1)
	for name, lines := range documents {
		if name != main {
			set[name] = join(lines)
		}
	}
	return set
}

// join joins the lines of a document of the case database.
func join(lines []string) string {
	out := ""
	for _, l := range lines {
		out += l + "\n"
	}
	return out
}

// TestCheckAndWrite pin the exit statuses: --check names an unformatted file and exits 1,
// --write rewrites it, and a formatted file leaves both quiet.
func TestCheckAndWrite(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	dir := t.TempDir()
	file := filepath.Join(dir, "x.dbs")
	if err := os.WriteFile(file, []byte("dbspec 1 x\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n\n\ntable items {\n  id i64 identity\n  primary key (id)\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := run([]string{"--check", file})
	if code := exitCode(err); code != exitUnformatted {
		t.Fatalf("--check of an unformatted file: code %d (%v); want %d", code, err, exitUnformatted)
	}
	if err := run([]string{"--write", file}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--check", file}); err != nil {
		t.Fatalf("--check of the written file: %v", err)
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "dbspec 1 x\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n\ntable items {\n  id i64 identity\n  primary key (id)\n}\n" {
		t.Fatalf("the written file:\n%s", b)
	}
}
