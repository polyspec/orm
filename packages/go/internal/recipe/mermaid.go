package recipe

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"slices"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/internal/dbspec/skeleton"
)

// mermaidStep runs the dbspec.export_mermaid or dbspec.import_mermaid op of s (FCV-4) on the public Mermaid calls (DBS-169) and
// returns its plain JSON result: {mermaid, dropped} for an export; {document, dropped}, {dropped, same_skeleton} or {errors} for
// an import. dir is the directory of the recipe, which the path and skeleton_of fields are relative to.
func mermaidStep(s step, bound map[string]result, dir string) (map[string]any, error) {
	if s.Op == "dbspec.export_mermaid" {
		return exportMermaid(s, dir)
	}
	return importMermaid(s, bound, dir)
}

func exportMermaid(s step, dir string) (map[string]any, error) {
	// The inline text and the other documents of its set, or the .dbs file document (FCV-4).
	source, set := inlineDocument(s)
	if s.Document != "" {
		text, diagnostics, err := dbspec.ReadFile(filepath.Join(dir, s.Document))
		if err != nil {
			return nil, err
		}
		if len(diagnostics) > 0 {
			return nil, fmt.Errorf("read %s: %v", s.Document, diagnostics)
		}
		source, set = text, nil
	}
	d, _, diagnostics := dbspec.Parse(source, set)
	if len(diagnostics) > 0 {
		return nil, fmt.Errorf("parse: %v", diagnostics)
	}
	text, dropped := dbspec.ExportMermaid(d)
	return map[string]any{"mermaid": text, "dropped": dropsOf(dropped)}, nil
}

func importMermaid(s step, bound map[string]result, dir string) (map[string]any, error) {
	text, err := mermaidText(s.Mermaid, bound)
	if err != nil {
		return nil, err
	}
	d, dropped, diagnostics := dbspec.ImportMermaid(text, s.Name)
	if len(diagnostics) > 0 {
		errs := []any{}
		for _, g := range diagnostics {
			errs = append(errs, []any{g.Rule, g.Line, g.Column})
		}
		return map[string]any{"errors": errs}, nil
	}
	if s.SkeletonOf == "" {
		return map[string]any{"document": dbspec.Emit(d), "dropped": dropsOf(dropped)}, nil
	}
	source, diagnostics2, err := dbspec.ReadFile(filepath.Join(dir, s.SkeletonOf))
	if err != nil {
		return nil, err
	}
	if len(diagnostics2) > 0 {
		return nil, fmt.Errorf("read %s: %v", s.SkeletonOf, diagnostics2)
	}
	original, _, diagnostics2 := dbspec.Parse(source, nil)
	if len(diagnostics2) > 0 {
		return nil, fmt.Errorf("parse %s: %v", s.SkeletonOf, diagnostics2)
	}
	same := slices.Equal(skeleton.Mermaid(original), skeleton.Mermaid(d))
	return map[string]any{"dropped": dropsOf(dropped), "same_skeleton": same}, nil
}

// mermaidText is the Mermaid text of an import: a plain text, or a ref to the mermaid of an export.
func mermaidText(raw json.RawMessage, bound map[string]result) (string, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text, nil
	}
	ref, ok, err := reference(raw, bound)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("mermaid is a text or a ref: %s", raw)
	}
	text, ok = ref.(string)
	if !ok {
		return "", fmt.Errorf("mermaid ref is not a text: %s", raw)
	}
	return text, nil
}

func dropsOf(us []dbspec.Unsupported) []any {
	out := []any{}
	for _, u := range us {
		out = append(out, []any{u.Kind, u.Table, u.Name})
	}
	return out
}

// checkMermaid compares the keys that the expect of a mermaid step names with the result, as JSON values.
func checkMermaid(raw json.RawMessage, got map[string]any) error {
	var outcome struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(raw, &outcome); err != nil {
		return err
	}
	var want map[string]any
	if err := json.Unmarshal(outcome.Value, &want); err != nil {
		return err
	}
	body, err := json.Marshal(got)
	if err != nil {
		return err
	}
	var actual map[string]any
	if err := json.Unmarshal(body, &actual); err != nil {
		return err
	}
	for key, w := range want {
		g, ok := actual[key]
		if !ok {
			return fmt.Errorf("the result has no %s: %s", key, body)
		}
		if !reflect.DeepEqual(g, w) {
			return fmt.Errorf("%s: got %v, want %v", key, g, w)
		}
	}
	return nil
}
