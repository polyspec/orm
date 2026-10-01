package dbspec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// TestMermaidVectors는 tests/dbspec/mermaid.json의 export, import, invalid
// case를 확인한다(docs/mermaid.md).
func TestMermaidVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "dbspec", "mermaid.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Version int `json:"version"`
		Export  []struct {
			ID       string      `json:"id"`
			Document []string    `json:"document"`
			Mermaid  []string    `json:"mermaid"`
			Dropped  [][3]string `json:"dropped"`
		} `json:"export"`
		Import []struct {
			ID       string      `json:"id"`
			Mermaid  []string    `json:"mermaid"`
			Document []string    `json:"document"`
			Dropped  [][3]string `json:"dropped"`
		} `json:"import"`
		Invalid []struct {
			ID      string   `json:"id"`
			Mermaid []string `json:"mermaid"`
			Errors  [][]any  `json:"errors"`
		} `json:"invalid"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if v.Version != 1 || len(v.Export) == 0 || len(v.Import) == 0 || len(v.Invalid) == 0 {
		t.Fatalf("tests/dbspec/mermaid.json has version %d and %d, %d and %d cases", v.Version, len(v.Export), len(v.Import), len(v.Invalid))
	}
	join := func(lines []string) string { return strings.Join(lines, "\n") + "\n" }
	drops := func(us []Unsupported) [][3]string {
		var out [][3]string
		for _, u := range us {
			out = append(out, [3]string{u.Kind, u.Table, u.Name})
		}
		return out
	}
	for _, c := range v.Export {
		t.Run("export/"+c.ID, func(t *testing.T) {
			start := time.Now()
			t.Logf("RUN mermaid/export/%s deadline=5s", c.ID)
			d, diagnostics := Parse(join(c.Document), nil)
			if len(diagnostics) > 0 {
				t.Fatal(diagnostics)
			}
			text, dropped := ExportMermaid(d)
			if text != join(c.Mermaid) {
				t.Errorf("mermaid\n--- want\n%s--- got\n%s", join(c.Mermaid), text)
			}
			if got := drops(dropped); !slices.Equal(got, c.Dropped) {
				t.Errorf("dropped\nwant %v\ngot  %v", c.Dropped, got)
			}
			t.Logf("PASS mermaid/export/%s elapsed=%s", c.ID, time.Since(start))
		})
	}
	for _, c := range v.Import {
		t.Run("import/"+c.ID, func(t *testing.T) {
			start := time.Now()
			t.Logf("RUN mermaid/import/%s deadline=5s", c.ID)
			d, dropped, diagnostics := ImportMermaid(join(c.Mermaid), "imported")
			if len(diagnostics) > 0 {
				t.Fatal(diagnostics)
			}
			if got := Emit(d); got != join(c.Document) {
				t.Errorf("document\n--- want\n%s--- got\n%s", join(c.Document), got)
			}
			if got := drops(dropped); !slices.Equal(got, c.Dropped) {
				t.Errorf("dropped\nwant %v\ngot  %v", c.Dropped, got)
			}
			t.Logf("PASS mermaid/import/%s elapsed=%s", c.ID, time.Since(start))
		})
	}
	for _, c := range v.Invalid {
		t.Run("invalid/"+c.ID, func(t *testing.T) {
			t.Logf("RUN mermaid/invalid/%s deadline=5s", c.ID)
			_, _, diagnostics := ImportMermaid(join(c.Mermaid), "imported")
			var got [][]any
			for _, d := range diagnostics {
				got = append(got, []any{d.Rule, float64(d.Line), float64(d.Column)})
			}
			gj, _ := json.Marshal(got)
			wj, _ := json.Marshal(c.Errors)
			if string(gj) != string(wj) {
				t.Errorf("errors\nwant %s\ngot  %s", wj, gj)
			}
			t.Logf("PASS mermaid/invalid/%s", c.ID)
		})
	}
}
