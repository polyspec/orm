package dbspec

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/internal/testcase"
)

// mermaidVectors는 tests/dbspec/mermaid.json이다(docs/mermaid.md).
type mermaidVectors struct {
	Export    []mermaidExportCase
	Import    []mermaidImportCase
	Invalid   []mermaidInvalidCase
	RoundTrip []mermaidRoundTripCase
}

type mermaidExportCase struct {
	ID        string
	Document  []string
	Documents map[string][]string
	Mermaid   []string
	Dropped   [][3]string
}

type mermaidImportCase struct {
	ID       string
	Mermaid  []string
	Document []string
	Dropped  [][3]string
}

type mermaidInvalidCase struct {
	ID      string
	Mermaid []string
	Errors  [][]any
}

type mermaidRoundTripCase struct {
	ID       string
	Path     string
	Dropped  [][3]string
	Imported [][3]string
}

func loadMermaidVectors(t *testing.T) mermaidVectors {
	t.Helper()
	r, object := readVectorFile(t, "mermaid.json")
	v, err := decodeMermaidVectors(r, object)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// decodeMermaidVectors는 mermaid.json의 모든 section과 field를 읽고, 없거나 type이
// 다른 값을 위치와 함께 거부한다.
func decodeMermaidVectors(r vectorReader, object map[string]any) (mermaidVectors, error) {
	var v mermaidVectors
	if err := r.version(object); err != nil {
		return v, err
	}
	var err error
	if v.Export, err = vectorCases(r, object, "export", func(c map[string]any, location, id string) (mermaidExportCase, error) {
		e := mermaidExportCase{ID: id}
		var err error
		if e.Document, err = r.linesField(c, location, "document"); err != nil {
			return e, err
		}
		if e.Documents, err = r.linesMap(c, location, "documents"); err != nil {
			return e, err
		}
		if e.Mermaid, err = r.linesField(c, location, "mermaid"); err != nil {
			return e, err
		}
		e.Dropped, err = r.triples(c, location, "dropped")
		return e, err
	}); err != nil {
		return v, err
	}
	if v.Import, err = vectorCases(r, object, "import", func(c map[string]any, location, id string) (mermaidImportCase, error) {
		m := mermaidImportCase{ID: id}
		var err error
		if m.Mermaid, err = r.linesField(c, location, "mermaid"); err != nil {
			return m, err
		}
		if m.Document, err = r.linesField(c, location, "document"); err != nil {
			return m, err
		}
		m.Dropped, err = r.triples(c, location, "dropped")
		return m, err
	}); err != nil {
		return v, err
	}
	if v.Invalid, err = vectorCases(r, object, "invalid", func(c map[string]any, location, id string) (mermaidInvalidCase, error) {
		m := mermaidInvalidCase{ID: id}
		var err error
		if m.Mermaid, err = r.linesField(c, location, "mermaid"); err != nil {
			return m, err
		}
		m.Errors, err = r.diagnostics(c, location, "errors", 3)
		return m, err
	}); err != nil {
		return v, err
	}
	v.RoundTrip, err = vectorCases(r, object, "round_trip", func(c map[string]any, location, id string) (mermaidRoundTripCase, error) {
		m := mermaidRoundTripCase{ID: id}
		var err error
		if m.Path, err = r.string(c, location, "path"); err != nil {
			return m, err
		}
		if m.Dropped, err = r.triples(c, location, "dropped"); err != nil {
			return m, err
		}
		m.Imported, err = r.triples(c, location, "imported")
		return m, err
	})
	return v, err
}

func mermaidJoin(lines []string) string { return strings.Join(lines, "\n") + "\n" }

func mermaidDrops(us []Unsupported) [][3]string {
	var out [][3]string
	for _, u := range us {
		out = append(out, [3]string{u.Kind, u.Table, u.Name})
	}
	return out
}

// TestMermaidVectors는 tests/dbspec/mermaid.json의 export, import, invalid
// case를 확인한다(docs/mermaid.md).
func TestMermaidVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	v := loadMermaidVectors(t)
	for _, c := range v.Export {
		t.Run("export/"+c.ID, func(t *testing.T) { checkMermaidExport(t, c) })
	}
	for _, c := range v.Import {
		t.Run("import/"+c.ID, func(t *testing.T) { checkMermaidImport(t, c) })
	}
	for _, c := range v.Invalid {
		t.Run("invalid/"+c.ID, func(t *testing.T) { checkMermaidInvalid(t, c) })
	}
	for _, c := range v.RoundTrip {
		t.Run("round_trip/"+c.ID, func(t *testing.T) { checkMermaidRoundTrip(t, c) })
	}
}

// jsonEqual은 got과 want의 JSON 표현이 같은지 확인한다.
func jsonEqual(what string, got, want any) error {
	gj, err := json.Marshal(got)
	if err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	wj, err := json.Marshal(want)
	if err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	if string(gj) != string(wj) {
		return fmt.Errorf("%s\nwant %s\ngot  %s", what, wj, gj)
	}
	return nil
}

func checkMermaidExport(t *testing.T, c mermaidExportCase) {
	runTimed(t, "mermaid/export/"+c.ID, 5*time.Second, func() error {
		set := map[string]string{}
		for name, lines := range c.Documents {
			set[name] = mermaidJoin(lines)
		}
		d, diagnostics := Parse(mermaidJoin(c.Document), set)
		if len(diagnostics) > 0 {
			return fmt.Errorf("parse: %v", diagnostics)
		}
		text, dropped := ExportMermaid(d)
		var problems []error
		if text != mermaidJoin(c.Mermaid) {
			problems = append(problems, fmt.Errorf("mermaid\n--- want\n%s--- got\n%s", mermaidJoin(c.Mermaid), text))
		}
		if got := mermaidDrops(dropped); !slices.Equal(got, c.Dropped) {
			problems = append(problems, fmt.Errorf("dropped\nwant %v\ngot  %v", c.Dropped, got))
		}
		return errors.Join(problems...)
	})
}

func checkMermaidImport(t *testing.T, c mermaidImportCase) {
	runTimed(t, "mermaid/import/"+c.ID, 5*time.Second, func() error {
		d, dropped, diagnostics := ImportMermaid(mermaidJoin(c.Mermaid), "imported")
		if len(diagnostics) > 0 {
			return fmt.Errorf("import: %v", diagnostics)
		}
		var problems []error
		if got := Emit(d); got != mermaidJoin(c.Document) {
			problems = append(problems, fmt.Errorf("document\n--- want\n%s--- got\n%s", mermaidJoin(c.Document), got))
		}
		if got := mermaidDrops(dropped); !slices.Equal(got, c.Dropped) {
			problems = append(problems, fmt.Errorf("dropped\nwant %v\ngot  %v", c.Dropped, got))
		}
		return errors.Join(problems...)
	})
}

func checkMermaidInvalid(t *testing.T, c mermaidInvalidCase) {
	runTimed(t, "mermaid/invalid/"+c.ID, 5*time.Second, func() error {
		_, _, diagnostics := ImportMermaid(mermaidJoin(c.Mermaid), "imported")
		var got [][]any
		for _, d := range diagnostics {
			got = append(got, []any{d.Rule, float64(d.Line), float64(d.Column)})
		}
		return jsonEqual("errors", got, c.Errors)
	})
}

func checkMermaidRoundTrip(t *testing.T, c mermaidRoundTripCase) {
	runTimed(t, "mermaid/round_trip/"+c.ID, 5*time.Second, func() error {
		source, diagnostics, err := ReadFile(filepath.Join("..", "..", c.Path))
		if err != nil {
			return err
		}
		if len(diagnostics) > 0 {
			return fmt.Errorf("read %s: %v", c.Path, diagnostics)
		}
		d, diagnostics := Parse(source, nil)
		if len(diagnostics) > 0 {
			return fmt.Errorf("parse %s: %v", c.Path, diagnostics)
		}
		text, dropped := ExportMermaid(d)
		var problems []error
		if got := mermaidDrops(dropped); !slices.Equal(got, c.Dropped) {
			problems = append(problems, fmt.Errorf("export dropped %d objects\nwant %v\ngot  %v", len(got), c.Dropped, got))
		}
		imported, reported, diagnostics := ImportMermaid(text, d.Name)
		if len(diagnostics) > 0 {
			return errors.Join(append(problems, fmt.Errorf("import: %v", diagnostics))...)
		}
		if got := mermaidDrops(reported); !slices.Equal(got, c.Imported) {
			problems = append(problems, fmt.Errorf("import dropped %d objects\nwant %v\ngot  %v", len(got), c.Imported, got))
		}
		if want, got := mermaidSkeleton(d), mermaidSkeleton(imported); !slices.Equal(got, want) {
			problems = append(problems, fmt.Errorf("tables, columns, primary keys and foreign keys\n--- want\n%s\n--- got\n%s", strings.Join(want, "\n"), strings.Join(got, "\n")))
		}
		return errors.Join(problems...)
	})
}

// mermaidSkeleton은 Mermaid가 옮기는 table, column, primary key, foreign key를
// table 이름 순서의 줄로 쓴다. foreign key action은 Mermaid가 옮기지 않으므로 뺀다.
func mermaidSkeleton(d *Document) []string {
	var out []string
	for _, t := range sortedBy(d.Tables, func(t Table) string { return t.Name }) {
		out = append(out, "table "+t.Name)
		for _, c := range t.Columns {
			dflt := "-"
			if c.Default != nil {
				dflt = c.Default.Literal
				if c.Default.Now {
					dflt = "now"
				}
			}
			out = append(out, fmt.Sprintf("column %s %s null=%t identity=%t default=%s", c.Name, c.Type, c.Null, c.Identity, dflt))
		}
		out = append(out, "primary key "+strings.Join(t.PrimaryKey.Columns, ", "))
		for _, f := range sortedBy(t.ForeignKeys, func(f ForeignKey) string { return f.Name }) {
			out = append(out, "foreign key "+f.Name+" ("+strings.Join(f.Columns, ", ")+") references "+f.Table+" ("+strings.Join(f.References, ", ")+")")
		}
	}
	return out
}
