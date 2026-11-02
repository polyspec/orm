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
		if s.Document == "" {
			text, set := inlineDocument(s)
			analysis := dbspec.Analyze(text, set)
			return checkTokens(analysis.Tokens, want.Tokens)
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
		return checkTokens(analysis.Tokens, want.Tokens)
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
		text, set := inlineDocument(s)
		if s.Document != "" {
			raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(s.Document)))
			if err != nil {
				return err
			}
			text = string(raw)
		}
		_, positions, diagnostics := dbspec.Parse(text, set)
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
		text, set := inlineDocument(s)
		if want.Diagnostics != nil {
			return checkRefusal(text, set, want.Diagnostics)
		}
		expected := strings.Join(want.Text, "\n") + "\n"
		emitted, err := emitStable(text, set)
		if err != nil {
			return err
		}
		if emitted != expected {
			return fmt.Errorf("emission differs:\n%s\nwant\n%s", emitted, expected)
		}
		formatted, diagnostics := dbspec.Format(text, set)
		if len(diagnostics) > 0 {
			return errors.New(runtimemodel.DiagnosticsError(diagnostics))
		}
		if formatted != expected {
			return fmt.Errorf("formatted text:\n%s\nwant\n%s", formatted, expected)
		}
		if again, _ := dbspec.Format(formatted, set); again != formatted {
			return fmt.Errorf("the format of the formatted text differs:\n%s", again)
		}
	case "dbspec.parse_set":
		var want struct {
			Documents []struct {
				Name        string `json:"name"`
				External    bool   `json:"external"`
				Parsed      bool   `json:"parsed"`
				Diagnostics []struct {
					Rule    string `json:"rule"`
					Line    int    `json:"line"`
					Column  int    `json:"column"`
					Message string `json:"message"`
				} `json:"diagnostics"`
			} `json:"documents"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		got := dbspec.ParseSet(s.Owned, s.External)
		if len(got) != len(want.Documents) {
			return fmt.Errorf("%d documents, want %d", len(got), len(want.Documents))
		}
		for i, w := range want.Documents {
			d := got[i]
			if d.Name != w.Name || d.External != w.External || (d.Document != nil) != w.Parsed || len(d.Diagnostics) != len(w.Diagnostics) {
				return fmt.Errorf("document %d is %q external=%v parsed=%v with %d diagnostics, want %+v", i, d.Name, d.External, d.Document != nil, len(d.Diagnostics), w)
			}
			for k, wd := range w.Diagnostics {
				x := d.Diagnostics[k]
				if string(x.Rule) != wd.Rule || x.Line != wd.Line || x.Column != wd.Column || (wd.Message != "" && x.Message != wd.Message) {
					return fmt.Errorf("document %d diagnostic %d is %+v, want %+v", i, k, x, wd)
				}
			}
		}
	case "dbspec.read_file", "dbspec.read_bytes":
		var want struct {
			Errors []struct {
				Line   int    `json:"line"`
				Column int    `json:"column"`
				Rule   string `json:"rule"`
			} `json:"errors"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		name := filepath.Join(dir, filepath.FromSlash(s.Path))
		var text string
		var diagnostics []dbspec.Diagnostic
		if s.Op == "dbspec.read_file" {
			var err error
			text, diagnostics, err = dbspec.ReadFile(name)
			if err != nil {
				return err
			}
		} else {
			raw, err := os.ReadFile(name)
			if err != nil {
				return err
			}
			name = s.Path
			text, diagnostics = dbspec.ReadBytes(name, raw)
		}
		if len(want.Errors) > 0 {
			if text != "" {
				return errors.New("the reader returned text with diagnostics")
			}
			if len(diagnostics) != len(want.Errors) {
				return fmt.Errorf("diagnostics = %+v, want %+v", diagnostics, want.Errors)
			}
			for i, d := range diagnostics {
				if message := name + fileMessages[string(d.Rule)]; d.Message != message {
					return fmt.Errorf("message = %q, want %q", d.Message, message)
				}
				w := want.Errors[i]
				if string(d.Rule) != w.Rule || d.Line != w.Line || d.Column != w.Column {
					return fmt.Errorf("diagnostic %d = %s %d %d, want %+v", i, d.Rule, d.Line, d.Column, w)
				}
			}
			return nil
		}
		if len(diagnostics) != 0 {
			return errors.New(runtimemodel.DiagnosticsError(diagnostics))
		}
		raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(s.Path)))
		if err != nil {
			return err
		}
		if text != string(raw) {
			return errors.New("the reader text differs from the file bytes")
		}
		emitted, err := emitStable(text, nil)
		if err != nil {
			return err
		}
		if emitted != text {
			return fmt.Errorf("emission differs:\n%s\nwant\n%s", emitted, text)
		}
	default:
		return fmt.Errorf("OP_UNKNOWN %s", s.Op)
	}
	return nil
}

// fileMessages is the suffix of the message of each file rule, after the name of the file.
var fileMessages = map[string]string{string(dbspec.RuleSignature): " is not a dbspec document", string(dbspec.RuleEncoding): " is not valid UTF-8"}

// joinText joins lines with LF, or with CRLF when crlf is set, with a final line ending. A mixed document starts with CRLF,
// alternates CRLF and LF from its second line, and has no final line ending.
func joinText(lines []string, crlf, mixed bool) string {
	if !mixed {
		end := "\n"
		if crlf {
			end = "\r\n"
		}
		return strings.Join(lines, end) + end
	}
	var b strings.Builder
	for i, line := range lines {
		if i > 0 {
			if i%2 == 1 {
				b.WriteString("\r\n")
			} else {
				b.WriteString("\n")
			}
		}
		b.WriteString(line)
	}
	return b.String()
}

// inlineDocument returns the text of a step and the set of its other documents, joined with the step's line endings.
func inlineDocument(s step) (string, map[string]string) {
	set := map[string]string{}
	for name, lines := range s.Set {
		set[name] = joinText(lines, s.CRLF, s.Mixed)
	}
	return joinText(s.Text, s.CRLF, s.Mixed), set
}

// emitStable parses text with the set, emits it, and checks that the emission parses and emits to itself.
func emitStable(text string, set map[string]string) (string, error) {
	document, _, diagnostics := dbspec.Parse(text, set)
	if len(diagnostics) > 0 || document == nil {
		return "", errors.New(runtimemodel.DiagnosticsError(diagnostics))
	}
	first := dbspec.Emit(document)
	again, _, diagnostics := dbspec.Parse(first, set)
	if len(diagnostics) > 0 || again == nil {
		return "", fmt.Errorf("parse of the emission: %s", runtimemodel.DiagnosticsError(diagnostics))
	}
	if second := dbspec.Emit(again); second != first {
		return "", fmt.Errorf("emission is not idempotent:\n%s\n%s", first, second)
	}
	return first, nil
}

// checkRefusal checks that parse refuses text with exactly the diagnostics of want, and that format returns no text
// and the same diagnostics.
func checkRefusal(text string, set map[string]string, want []struct {
	Rule   string `json:"rule"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
}) error {
	document, _, parsed := dbspec.Parse(text, set)
	if document != nil {
		return errors.New("Parse returned a document for an invalid source")
	}
	formatted, diagnostics := dbspec.Format(text, set)
	if formatted != "" {
		return fmt.Errorf("a document with a diagnostic was rewritten:\n%s", formatted)
	}
	for _, got := range [][]dbspec.Diagnostic{parsed, diagnostics} {
		if len(got) != len(want) || len(got) == 0 {
			return fmt.Errorf("diagnostics = %+v, want %+v", got, want)
		}
		for i, d := range got {
			if d.Message == "" {
				return fmt.Errorf("diagnostic %+v has no message", d)
			}
			w := want[i]
			if string(d.Rule) != w.Rule || d.Line != w.Line || d.Column != w.Column {
				return fmt.Errorf("diagnostic %d = %s %d %d, want %+v", i, d.Rule, d.Line, d.Column, w)
			}
		}
	}
	return nil
}

// checkTokens compares the tokens of an analysis with the tokens of a case, as line, start, end and class.
func checkTokens(tokens []dbspec.Token, want [][4]any) error {
	got := make([][4]any, len(tokens))
	for j, token := range tokens {
		got[j] = [4]any{float64(token.Line), float64(token.Start), float64(token.End), token.Class}
	}
	if len(got) != len(want) || (len(got) > 0 && !reflect.DeepEqual(got, want)) {
		return fmt.Errorf("tokens:\n got %v\nwant %v", got, want)
	}
	return nil
}
