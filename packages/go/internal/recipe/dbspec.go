package recipe

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
)

// readDocuments reads the .dbs files that paths name relative to dir, and parses them with the set of their headers.
// It returns the text of each file and its parsed document, in the order of paths.
func readDocuments(dir string, paths []string) ([]string, []*dbspec.Document, error) {
	texts := make([]string, len(paths))
	set := map[string]string{}
	for i, path := range paths {
		b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(path)))
		if err != nil {
			return nil, nil, err
		}
		texts[i] = string(b)
		fields := strings.Fields(strings.SplitN(texts[i], "\n", 2)[0])
		if len(fields) != 3 || fields[0] != "dbspec" {
			return nil, nil, fmt.Errorf("%s has no dbspec header", path)
		}
		set[fields[2]] = texts[i]
	}
	documents := make([]*dbspec.Document, len(texts))
	for i, text := range texts {
		document, _, diagnostics := dbspec.Parse(text, set)
		if len(diagnostics) > 0 {
			return nil, nil, fmt.Errorf("%s: %s", paths[i], runtimemodel.DiagnosticsError(diagnostics))
		}
		documents[i] = document
	}
	return texts, documents, nil
}

// checkDBSpec runs one dbspec op of a recipe step through the public calls of the dbspec package and checks the
// result against the expect of database.
func checkDBSpec(s step, dir, database string) error {
	raw, ok := s.Expect[database]
	if !ok {
		return fmt.Errorf("%s has no expect for %s", s.Op, database)
	}
	switch s.Op {
	case "dbspec.parse_emit":
		var want struct {
			Identical bool `json:"identical"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		texts, documents, err := readDocuments(dir, s.Documents)
		if err != nil {
			return err
		}
		identical := true
		for i, document := range documents {
			identical = identical && dbspec.Emit(document) == texts[i]
		}
		if identical != want.Identical {
			return fmt.Errorf("emit identical = %t, want %t", identical, want.Identical)
		}
	case "dbspec.manifest":
		var want struct {
			ManifestHash string `json:"manifest_hash"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		_, documents, err := readDocuments(dir, s.Documents)
		if err != nil {
			return err
		}
		manifest, diagnostics := dbspec.ManifestOf(documents)
		if len(diagnostics) > 0 {
			return errors.New(runtimemodel.DiagnosticsError(diagnostics))
		}
		if want.ManifestHash == "" || manifest.ManifestHash != want.ManifestHash {
			return fmt.Errorf("manifest hash = %s, want %s", manifest.ManifestHash, want.ManifestHash)
		}
	case "dbspec.render":
		var want struct {
			MySQL    []string `json:"mysql"`
			Postgres []string `json:"postgres"`
			SQLite   []string `json:"sqlite"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		_, documents, err := readDocuments(dir, s.Documents)
		if err != nil {
			return err
		}
		for dialect, wantStatements := range map[string][]string{"mysql": want.MySQL, "postgres": want.Postgres, "sqlite": want.SQLite} {
			got, diagnostics := dbspec.Render(documents, dbspec.Dialect(dialect))
			if len(diagnostics) > 0 {
				return fmt.Errorf("%s: %s", dialect, runtimemodel.DiagnosticsError(diagnostics))
			}
			if len(wantStatements) == 0 || !slices.Equal(got, wantStatements) {
				return fmt.Errorf("%s statements:\n got %q\nwant %q", dialect, got, wantStatements)
			}
		}
	case "dbspec.analyze":
		var want struct {
			Tokens [][4]any `json:"tokens"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		text, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(s.Document)))
		if err != nil {
			return err
		}
		analysis := dbspec.Analyze(string(text), nil)
		parsed, positions, _ := dbspec.Parse(string(text), nil)
		if len(analysis.Diagnostics) > 0 {
			return errors.New(runtimemodel.DiagnosticsError(analysis.Diagnostics))
		}
		if dbspec.Emit(analysis.Document) != dbspec.Emit(parsed) || !reflect.DeepEqual(analysis.Positions, positions) {
			return errors.New("the analysis differs from the parse")
		}
		got := make([][4]any, len(analysis.Tokens))
		for j, token := range analysis.Tokens {
			got[j] = [4]any{float64(token.Line), float64(token.Start), float64(token.End), token.Class}
		}
		if len(want.Tokens) == 0 || !reflect.DeepEqual(got, want.Tokens) {
			return fmt.Errorf("tokens:\n got %v\nwant %v", got, want.Tokens)
		}
	case "dbspec.parse_positions":
		var want struct {
			Positions []struct {
				Kind   string   `json:"kind"`
				Path   []string `json:"path"`
				Line   int      `json:"line"`
				Column int      `json:"column"`
			} `json:"positions"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		text, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(s.Document)))
		if err != nil {
			return err
		}
		_, positions, diagnostics := dbspec.Parse(string(text), nil)
		if len(diagnostics) > 0 {
			return errors.New(runtimemodel.DiagnosticsError(diagnostics))
		}
		if len(positions) != len(want.Positions) || len(positions) == 0 {
			return fmt.Errorf("%d positions, want %d", len(positions), len(want.Positions))
		}
		for j, p := range positions {
			w := want.Positions[j]
			if p.Kind != w.Kind || !slices.Equal(p.Path, w.Path) || p.Line != w.Line || p.Column != w.Column {
				return fmt.Errorf("position %d = %+v, want %+v", j, p, w)
			}
		}
	case "dbspec.format":
		var want struct {
			Text        []string `json:"text"`
			Diagnostics []struct {
				Rule   string `json:"rule"`
				Line   int    `json:"line"`
				Column int    `json:"column"`
			} `json:"diagnostics"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		if len(s.Text) == 0 {
			return errors.New("dbspec.format has no text")
		}
		formatted, diagnostics := dbspec.Format(strings.Join(s.Text, "\n")+"\n", nil)
		if want.Diagnostics != nil {
			if formatted != "" {
				return fmt.Errorf("a document with a diagnostic was rewritten:\n%s", formatted)
			}
			if len(diagnostics) != len(want.Diagnostics) || len(diagnostics) == 0 {
				return fmt.Errorf("diagnostics = %+v, want %+v", diagnostics, want.Diagnostics)
			}
			for i, d := range diagnostics {
				w := want.Diagnostics[i]
				if string(d.Rule) != w.Rule || d.Line != w.Line || d.Column != w.Column {
					return fmt.Errorf("diagnostic %d = %s %d %d, want %+v", i, d.Rule, d.Line, d.Column, w)
				}
			}
			return nil
		}
		if len(diagnostics) > 0 {
			return errors.New(runtimemodel.DiagnosticsError(diagnostics))
		}
		if want := strings.Join(want.Text, "\n") + "\n"; formatted != want {
			return fmt.Errorf("formatted text:\n%s\nwant\n%s", formatted, want)
		}
		if again, _ := dbspec.Format(formatted, nil); again != formatted {
			return fmt.Errorf("the format of the formatted text differs:\n%s", again)
		}
	default:
		return fmt.Errorf("OP_UNKNOWN %s", s.Op)
	}
	return nil
}
