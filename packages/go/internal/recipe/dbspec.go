package recipe

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
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

// linesText is the text of a list of lines, each ended by a line feed; no lines are the empty text.
func linesText(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

// checkDBSpec runs one dbspec op of a recipe step through the public calls of the dbspec package and checks the
// result against the expect of database.
func checkDBSpec(s step, dir, database string) error {
	raw, ok := s.k("expect").Expect[database]
	if !ok {
		return fmt.Errorf("%s has no expect for %s", s.k("op").Op, database)
	}
	switch s.k("op").Op {
	case "dbspec.parse_emit":
		var want struct {
			Identical bool `json:"identical"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		texts, documents, err := readDocuments(dir, s.k("documents").Documents)
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
		_, documents, err := readDocuments(dir, s.k("documents").Documents)
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
			Refused  string   `json:"refused"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		_, documents, err := readDocuments(dir, s.k("documents").Documents)
		if err != nil {
			return err
		}
		if s.k("dialect").Dialect != "" {
			got, err := dialectRefusal(s.k("dialect").Dialect, func() { dbspec.Render(documents, dbspec.Dialect(s.k("dialect").Dialect)) })
			if err != nil {
				return err
			}
			if want.Refused != s.k("dialect").Dialect {
				return fmt.Errorf("refused %v, want %q", got, want.Refused)
			}
			return nil
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
		text, set := inlineDocument(s)
		if s.k("document").Document != "" {
			raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(s.k("document").Document)))
			if err != nil {
				return err
			}
			text, set = string(raw), nil
		}
		analysis := dbspec.Analyze(text, set)
		if s.k("document").Document != "" && len(analysis.Diagnostics) > 0 {
			return errors.New(runtimemodel.DiagnosticsError(analysis.Diagnostics))
		}
		parsed, positions, diagnostics := dbspec.Parse(text, set)
		if !reflect.DeepEqual(analysis.Document, parsed) || !reflect.DeepEqual(analysis.Positions, positions) || !reflect.DeepEqual(analysis.Diagnostics, diagnostics) {
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
		if s.k("document").Document != "" {
			raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(s.k("document").Document)))
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
			Text        textLines `json:"text"`
			Diagnostics []struct {
				Rule   string `json:"rule"`
				Line   int    `json:"line"`
				Column int    `json:"column"`
			} `json:"diagnostics"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		if len(s.k("text").Text) == 0 {
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
	case "dbspec.load_set":
		var want struct {
			Documents []struct {
				Name     string `json:"name"`
				External bool   `json:"external"`
			} `json:"documents"`
			Error        string   `json:"error"`
			ManifestHash string   `json:"manifest_hash"`
			Diagnostics  []string `json:"diagnostics"`
			Message      string   `json:"message"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		model, invalid := runtimemodel.LoadSet(linesText(s.k("owned").Owned), linesText(s.k("external").External))
		if invalid != nil {
			if invalid.Code() != want.Error {
				return fmt.Errorf("%v, want %+v", invalid, want)
			}
			if want.Message != "" && invalid.Message() != want.Message {
				return fmt.Errorf("message %q, want %q", invalid.Message(), want.Message)
			}
			// Each diagnostic is "<line>:<column> <rule>: <message>", in order (SCH-12).
			if want.Diagnostics != nil {
				problems := strings.Split(invalid.Message(), "; ")
				if len(problems) != len(want.Diagnostics) {
					return fmt.Errorf("%v, want %+v", invalid, want)
				}
				for i, problem := range problems {
					if !strings.HasPrefix(problem, want.Diagnostics[i]+": ") {
						return fmt.Errorf("%v, want %+v", invalid, want)
					}
				}
			}
			return nil
		}
		if want.Error != "" {
			return fmt.Errorf("the set loaded, want %s", want.Error)
		}
		if want.ManifestHash != "" && model.ManifestHash != want.ManifestHash {
			return fmt.Errorf("manifest hash %s, want %s", model.ManifestHash, want.ManifestHash)
		}
		if len(model.Documents) != len(want.Documents) {
			return fmt.Errorf("%d documents, want %d", len(model.Documents), len(want.Documents))
		}
		for i, w := range want.Documents {
			if d := model.Documents[i]; d.Name != w.Name || d.External != w.External {
				return fmt.Errorf("documents[%d] = %s external %v, want %s external %v", i, d.Name, d.External, w.Name, w.External)
			}
		}
	case "dbspec.runtime_model":
		var want runtimeModelView
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		read := func(paths []string) ([]string, error) {
			texts := make([]string, len(paths))
			for i, path := range paths {
				text, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(path)))
				if err != nil {
					return nil, err
				}
				texts[i] = string(text)
			}
			return texts, nil
		}
		owned, err := read(s.k("documents").Documents)
		if err != nil {
			return err
		}
		external, err := read(s.k("external").External)
		if err != nil {
			return err
		}
		model, diagnostics := runtimemodel.LoadDocumentSet(owned, external)
		if len(diagnostics) > 0 {
			return errors.New(runtimemodel.DiagnosticsError(diagnostics))
		}
		return checkRuntimeModel(model, want)
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
		got := dbspec.ParseSet(s.k("owned").Owned, s.k("external").External)
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
	case "dbspec.set":
		var want struct {
			Diagnostics []setDiagnostic `json:"diagnostics"`
			Manifest    *setManifest    `json:"manifest"`
			Created     []string        `json:"created"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		return checkSet(s, want.Diagnostics, want.Manifest, want.Created)
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
		name := filepath.Join(dir, filepath.FromSlash(s.k("path").Path))
		var text string
		var diagnostics []dbspec.Diagnostic
		if s.k("op").Op == "dbspec.read_file" {
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
			name = s.k("path").Path
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
		raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(s.k("path").Path)))
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
		return fmt.Errorf("OP_UNKNOWN %s", s.k("op").Op)
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
// textLines is the lines of a text (FCV-4): a repeat gives its lines count times with {var} replaced, a fill one line of its text.
type textLines []string

// UnmarshalJSON expands the forms of a text as it decodes them.
func (l *textLines) UnmarshalJSON(data []byte) error {
	var items []json.RawMessage
	if err := json.Unmarshal(data, &items); err != nil {
		return err
	}
	out := []string{}
	for _, item := range items {
		var line string
		if json.Unmarshal(item, &line) == nil {
			out = append(out, line)
			continue
		}
		var form struct {
			Fill *struct {
				Text  string `json:"text"`
				Count int    `json:"count"`
			} `json:"fill"`
			Repeat *struct {
				Var   string    `json:"var"`
				From  int       `json:"from"`
				Count int       `json:"count"`
				Lines textLines `json:"lines"`
			} `json:"repeat"`
		}
		if err := json.Unmarshal(item, &form); err != nil {
			return err
		}
		if form.Fill != nil {
			out = append(out, strings.Repeat(form.Fill.Text, form.Fill.Count))
			continue
		}
		if form.Repeat == nil {
			return fmt.Errorf("the text line %s is no text, repeat or fill", item)
		}
		mark := "{" + form.Repeat.Var + "}"
		for i := form.Repeat.From; i < form.Repeat.From+form.Repeat.Count; i++ {
			text := strconv.Itoa(i)
			for _, inner := range form.Repeat.Lines {
				out = append(out, strings.ReplaceAll(inner, mark, text))
			}
		}
	}
	*l = out
	return nil
}

func inlineDocument(s step) (string, map[string]string) {
	set := map[string]string{}
	for name, lines := range s.k("set").Set {
		set[name] = joinText(lines, s.k("crlf").CRLF, s.k("mixed").Mixed)
	}
	return joinText(s.k("text").Text, s.k("crlf").CRLF, s.k("mixed").Mixed), set
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

// setDiagnostic is one expected diagnostic of dbspec.set.
type setDiagnostic struct {
	Rule   string `json:"rule"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
}

// setManifest is the expected manifest of dbspec.set: its texts and hashes, and external_text when it is given.
type setManifest struct {
	ManifestText string  `json:"manifest_text"`
	ExternalText *string `json:"external_text"`
	SchemaText   string  `json:"schema_text"`
	ManifestHash string  `json:"manifest_hash"`
	SchemaHash   string  `json:"schema_hash"`
}

// headerName is the name of a document, the third word of its header line.
func headerName(text string) string {
	fields := strings.Fields(strings.SplitN(text, "\n", 2)[0])
	if len(fields) < 3 {
		return ""
	}
	return fields[2]
}

// splitDocuments splits a manifest or external text into its document texts at each header line.
func splitDocuments(text string) []string {
	var out []string
	for text != "" {
		end := strings.Index(text, "\ndbspec ")
		if end < 0 {
			return append(out, text)
		}
		out = append(out, text[:end+1])
		text = text[end+1:]
	}
	return out
}

// createdTables is the table names that the CREATE TABLE statements create.
func createdTables(statements []string) []string {
	var out []string
	for _, s := range statements {
		if rest, ok := strings.CutPrefix(s, "CREATE TABLE "); ok {
			name, _, _ := strings.Cut(rest, " ")
			out = append(out, strings.Trim(name, "`\""))
		}
	}
	return out
}

// checkSet runs dbspec.set. The owned texts, then the external texts, are parsed each against the other texts and the
// parsing texts, and ManifestOf builds the set's manifest. A refused set (diagnostics not empty) expects those diagnostics
// from ManifestOf and from each dialect of Render, and no statements. A built set expects its texts and hashes when
// manifest is given, parses its manifest and external texts back as a set without diagnostics, gives the same manifest
// in the reversed order, and renders non-empty statements in each dialect that create the tables of created.
func checkSet(s step, diagnostics []setDiagnostic, manifest *setManifest, created []string) error {
	all := append(slices.Clone(s.k("owned").Owned), s.k("external").External...)
	documents := make([]*dbspec.Document, 0, len(all))
	for i, text := range all {
		set := map[string]string{}
		for name, other := range s.k("parsing").Parsing {
			set[name] = other
		}
		for j, other := range all {
			if j != i {
				set[headerName(other)] = other
			}
		}
		document, _, parseDiagnostics := dbspec.Parse(text, set)
		if len(parseDiagnostics) > 0 {
			return fmt.Errorf("document %d: %s", i+1, runtimemodel.DiagnosticsError(parseDiagnostics))
		}
		document.External = i >= len(s.k("owned").Owned)
		documents = append(documents, document)
	}
	built, refusals := dbspec.ManifestOf(documents)
	if err := sameDiagnostics(diagnostics, refusals); err != nil {
		return fmt.Errorf("manifest: %w", err)
	}
	refused := len(diagnostics) > 0
	if refused == (built != nil) {
		return fmt.Errorf("manifest built: %v for %d expected diagnostics", built != nil, len(diagnostics))
	}
	for _, dialect := range []dbspec.Dialect{dbspec.DialectMySQL, dbspec.DialectPostgres, dbspec.DialectSQLite} {
		statements, renderDiagnostics := dbspec.Render(documents, dialect)
		if refused {
			if err := sameDiagnostics(diagnostics, renderDiagnostics); err != nil {
				return fmt.Errorf("render %s: %w", dialect, err)
			}
			if len(statements) != 0 {
				return fmt.Errorf("render %s: %d statements for a refused set", dialect, len(statements))
			}
			continue
		}
		if len(renderDiagnostics) > 0 || len(statements) == 0 {
			return fmt.Errorf("render %s: %d statements with %s", dialect, len(statements), runtimemodel.DiagnosticsError(renderDiagnostics))
		}
		if created != nil && !slices.Equal(createdTables(statements), created) {
			return fmt.Errorf("render %s creates %v, want %v", dialect, createdTables(statements), created)
		}
	}
	if refused {
		return nil
	}
	if manifest != nil {
		for _, field := range []struct{ name, got, want string }{
			{"manifest_text", built.ManifestText, manifest.ManifestText},
			{"schema_text", built.SchemaText, manifest.SchemaText},
			{"manifest_hash", built.ManifestHash, manifest.ManifestHash},
			{"schema_hash", built.SchemaHash, manifest.SchemaHash},
		} {
			if field.got != field.want {
				return fmt.Errorf("%s:\n%s\nwant\n%s", field.name, field.got, field.want)
			}
		}
		if manifest.ExternalText != nil && built.ExternalText != *manifest.ExternalText {
			return fmt.Errorf("external_text:\n%s\nwant\n%s", built.ExternalText, *manifest.ExternalText)
		}
	}
	for _, r := range dbspec.ParseSet(splitDocuments(built.ManifestText), splitDocuments(built.ExternalText)) {
		if len(r.Diagnostics) > 0 {
			return fmt.Errorf("manifest and external text of %s do not parse back: %v", r.Name, r.Diagnostics)
		}
	}
	slices.Reverse(documents)
	reversed, _ := dbspec.ManifestOf(documents)
	if reversed == nil || reversed.ManifestHash != built.ManifestHash || reversed.SchemaHash != built.SchemaHash {
		return fmt.Errorf("the manifest of the reversed set differs")
	}
	return nil
}

// sameDiagnostics checks that got has the rule, line and column of each expected diagnostic, in order.
func sameDiagnostics(want []setDiagnostic, got []dbspec.Diagnostic) error {
	if len(got) != len(want) {
		return fmt.Errorf("diagnostics %v, want %v", got, want)
	}
	for i := range want {
		if string(got[i].Rule) != want[i].Rule || got[i].Line != want[i].Line || got[i].Column != want[i].Column {
			return fmt.Errorf("diagnostics %v, want %v", got, want)
		}
	}
	return nil
}

// runtimeModelView is the expect of a dbspec.runtime_model step (FCV-4): the entity names in order and, for the entities and
// fields it names, the values it names.
type runtimeModelView struct {
	Entities []string `json:"entities"`
	// ManifestText is the lines of the manifest text and ManifestHash its hash, when the expect names them.
	ManifestText []string                  `json:"manifest_text"`
	ManifestHash string                    `json:"manifest_hash"`
	Models       map[string]map[string]any `json:"models"`
}

// checkRuntimeModel compares the runtime model with the values that want names.
func checkRuntimeModel(m *runtimemodel.Model, want runtimeModelView) error {
	if !slices.Equal(m.Order, want.Entities) {
		return fmt.Errorf("entities %v, want %v", m.Order, want.Entities)
	}
	if want.ManifestText != nil && m.ManifestText != strings.Join(want.ManifestText, "\n")+"\n" {
		return fmt.Errorf("manifest text %q, want %q", m.ManifestText, want.ManifestText)
	}
	if want.ManifestHash != "" && m.ManifestHash != want.ManifestHash {
		return fmt.Errorf("manifest hash %s, want %s", m.ManifestHash, want.ManifestHash)
	}
	for name, values := range want.Models {
		e := m.Entities[name]
		if e == nil {
			return fmt.Errorf("no entity %s", name)
		}
		column, record := "", ""
		if e.Audit != nil {
			column, record = e.Audit.Column, e.Audit.Record
		}
		got := map[string]any{"table": e.Table, "primary_key": e.PK, "identity": e.Identity, "updated": e.Updated,
			"soft_delete": e.SoftDelete, "aes_version": e.AESVersion, "audit_column": column, "audit_record": record}
		keys := []string{}
		for _, u := range e.Uniques {
			keys = append(keys, u.Name)
		}
		for name := range e.Indexes {
			keys = append(keys, name)
		}
		slices.Sort(keys)
		got["key_names"] = keys
		fields := map[string]any{}
		for _, f := range e.Fields {
			fields[f.Name] = map[string]any{"type": f.Type, "nullable": f.Null, "default": f.Default, "default_now": f.DefaultNow, "select_explicit": f.SelectExplicit,
				"codec": f.Codec, "blind_index": f.BlindIndex, "primary_key": f.PrimaryKey, "foreign_key": f.ForeignKey}
		}
		got["fields"] = fields
		body, err := json.Marshal(got)
		if err != nil {
			return err
		}
		var actual map[string]any
		if err := json.Unmarshal(body, &actual); err != nil {
			return err
		}
		if err := namedValuesEqual(name, actual, values); err != nil {
			return err
		}
	}
	return nil
}

// namedValuesEqual compares the keys that want names, an object key by key and any other value as a whole; a nil list and an
// empty list are the same list.
func namedValuesEqual(path string, got, want map[string]any) error {
	for key, w := range want {
		g, ok := got[key]
		if !ok {
			return fmt.Errorf("%s has no %s", path, key)
		}
		if nested, ok := w.(map[string]any); ok {
			inner, ok := g.(map[string]any)
			if !ok {
				return fmt.Errorf("%s.%s = %v, want an object", path, key, g)
			}
			if err := namedValuesEqual(path+"."+key, inner, nested); err != nil {
				return err
			}
			continue
		}
		if list, ok := w.([]any); ok && len(list) == 0 && g == nil {
			continue
		}
		if !reflect.DeepEqual(g, w) {
			return fmt.Errorf("%s.%s = %v, want %v", path, key, g, w)
		}
	}
	return nil
}
