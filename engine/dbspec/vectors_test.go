package dbspec

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type vectorFile struct {
	Canonical []vectorCase
	Normalize []vectorCase
	Invalid   []vectorCase
	Hashes    []hashCase
	Sets      []setCase
	Files     []fileCase
}

// fileCase는 cases.json의 files case다. path는 cases.json 기준 상대 경로다.
type fileCase struct {
	ID     string
	Path   string
	Errors []vectorError
}

type vectorCase struct {
	ID        string
	CRLF      bool
	Mixed     bool
	Documents map[string][]string
	Main      string
	Canonical []string
	Errors    []vectorError
}

type vectorError struct {
	Line   int
	Column int
	Rule   string
}

func joinLines(lines []string, crlf bool) string {
	end := "\n"
	if crlf {
		end = "\r\n"
	}
	return strings.Join(lines, end) + end
}

// join은 case 문서 하나의 줄을 LF로, CRLF로, 또는 mixed case이면 CRLF부터 CRLF와 LF를
// 번갈아 마지막 줄 끝 없이 잇는다.
func (c vectorCase) join(lines []string) string {
	if !c.Mixed {
		return joinLines(lines, c.CRLF)
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

// documentSet은 main text와 선언한 문서 집합, 곧 main이 아닌 case의 모든 문서를 돌려준다.
func (c vectorCase) documentSet() (string, map[string]string, error) {
	main, ok := c.Documents[c.Main]
	if !ok {
		return "", nil, fmt.Errorf("main document %q is not listed", c.Main)
	}
	set := map[string]string{}
	for name, lines := range c.Documents {
		if name != c.Main {
			set[name] = c.join(lines)
		}
	}
	return c.join(main), set, nil
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	r, object := readVectorFile(t, "cases.json")
	vectors, err := decodeCaseVectors(r, object)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, group := range [][]vectorCase{vectors.Canonical, vectors.Normalize, vectors.Invalid} {
		for _, c := range group {
			if c.ID == "" || seen[c.ID] {
				t.Fatalf("case id %q is empty or repeated", c.ID)
			}
			seen[c.ID] = true
		}
	}
	return vectors
}

// decodeCaseVectors는 cases.json의 모든 section과 field를 읽고, 없거나 type이 다른
// 값을 위치와 함께 거부한다. normalize case는 canonical을, invalid case는 errors를
// 가지며, crlf와 mixed는 없으면 false다.
func decodeCaseVectors(r vectorReader, object map[string]any) (vectorFile, error) {
	var v vectorFile
	if err := r.version(object); err != nil {
		return v, err
	}
	readCase := func(canonical, errors bool) func(c map[string]any, location, id string) (vectorCase, error) {
		return func(c map[string]any, location, id string) (vectorCase, error) {
			vc := vectorCase{ID: id}
			var err error
			if vc.Main, err = r.string(c, location, "main"); err != nil {
				return vc, err
			}
			if vc.Documents, err = r.linesMap(c, location, "documents"); err != nil {
				return vc, err
			}
			if _, ok := vc.Documents[vc.Main]; !ok {
				return vc, r.fail(vectorAt(vectorAt(location, "documents"), vc.Main), "is missing")
			}
			if vc.CRLF, err = r.flag(c, location, "crlf"); err != nil {
				return vc, err
			}
			if vc.Mixed, err = r.flag(c, location, "mixed"); err != nil {
				return vc, err
			}
			if canonical {
				if vc.Canonical, err = r.linesField(c, location, "canonical"); err != nil {
					return vc, err
				}
			}
			if errors {
				vc.Errors, err = r.locatedErrors(c, location, "errors")
			}
			return vc, err
		}
	}
	var err error
	if v.Canonical, err = vectorCases(r, object, "canonical", readCase(false, false)); err != nil {
		return v, err
	}
	if v.Normalize, err = vectorCases(r, object, "normalize", readCase(true, false)); err != nil {
		return v, err
	}
	if v.Invalid, err = vectorCases(r, object, "invalid", readCase(false, true)); err != nil {
		return v, err
	}
	if v.Hashes, err = vectorCases(r, object, "hashes", func(c map[string]any, location, id string) (hashCase, error) {
		h := hashCase{ID: id}
		var err error
		if h.Documents, err = r.linesMap(c, location, "documents"); err != nil {
			return h, err
		}
		if h.ManifestText, err = r.linesField(c, location, "manifestText"); err != nil {
			return h, err
		}
		if h.SchemaText, err = r.linesField(c, location, "schemaText"); err != nil {
			return h, err
		}
		if h.ManifestHash, err = r.string(c, location, "manifestHash"); err != nil {
			return h, err
		}
		h.SchemaHash, err = r.string(c, location, "schemaHash")
		return h, err
	}); err != nil {
		return v, err
	}
	v.Sets, err = vectorCases(r, object, "sets", func(c map[string]any, location, id string) (setCase, error) {
		s := setCase{ID: id}
		items, err := r.arrayField(c, location, "documents")
		if err != nil {
			return s, err
		}
		for i, item := range items {
			lines, err := r.lines(item, fmt.Sprintf("%s[%d]", vectorAt(location, "documents"), i))
			if err != nil {
				return s, err
			}
			s.Documents = append(s.Documents, lines)
		}
		if s.Parsing, err = r.linesMap(c, location, "parsing"); err != nil {
			return s, err
		}
		s.Errors, err = r.locatedErrors(c, location, "errors")
		return s, err
	})
	if err != nil {
		return v, err
	}
	v.Files, err = vectorCases(r, object, "files", func(c map[string]any, location, id string) (fileCase, error) {
		f := fileCase{ID: id}
		var err error
		if f.Path, err = r.string(c, location, "path"); err != nil {
			return f, err
		}
		f.Errors, err = r.locatedErrors(c, location, "errors")
		return f, err
	})
	return v, err
}

// emitStable은 text를 parse해 emit하고, 그 emission을 다시 parse해 emit하면 byte까지 같은지
// 확인한다.
func emitStable(text string, set map[string]string) (string, error) {
	document, diagnostics := Parse(text, set)
	if err := expectDocument(document, diagnostics); err != nil {
		return "", err
	}
	first := Emit(document)
	again, diagnostics := Parse(first, set)
	if err := expectDocument(again, diagnostics); err != nil {
		return "", fmt.Errorf("parse of the emission: %w", err)
	}
	if second := Emit(again); second != first {
		return "", fmt.Errorf("emission is not idempotent:\nfirst:\n%s\nsecond:\n%s", first, second)
	}
	return first, nil
}

func expectDocument(document *Document, diagnostics []Diagnostic) error {
	if len(diagnostics) != 0 {
		return fmt.Errorf("unexpected diagnostics %+v", diagnostics)
	}
	if document == nil {
		return fmt.Errorf("Parse returned neither a document nor diagnostics")
	}
	return nil
}

func TestSharedVectors(t *testing.T) {
	vectors := loadVectors(t)
	for _, c := range vectors.Canonical {
		t.Run("canonical/"+c.ID, func(t *testing.T) {
			runTimed(t, "canonical/"+c.ID, 5*time.Second, func() error {
				text, set, err := c.documentSet()
				if err != nil {
					return err
				}
				got, err := emitStable(text, set)
				if err != nil {
					return err
				}
				if want := joinLines(c.Documents[c.Main], false); got != want {
					return fmt.Errorf("emission differs:\ngot:\n%s\nwant:\n%s", got, want)
				}
				return nil
			})
		})
	}
	for _, c := range vectors.Normalize {
		t.Run("normalize/"+c.ID, func(t *testing.T) {
			runTimed(t, "normalize/"+c.ID, 5*time.Second, func() error {
				text, set, err := c.documentSet()
				if err != nil {
					return err
				}
				got, err := emitStable(text, set)
				if err != nil {
					return err
				}
				if want := joinLines(c.Canonical, false); got != want {
					return fmt.Errorf("emission differs:\ngot:\n%s\nwant:\n%s", got, want)
				}
				return nil
			})
		})
	}
	for _, c := range vectors.Invalid {
		t.Run("invalid/"+c.ID, func(t *testing.T) {
			runTimed(t, "invalid/"+c.ID, 5*time.Second, func() error {
				text, set, err := c.documentSet()
				if err != nil {
					return err
				}
				return expectDiagnostics(text, set, c.Errors)
			})
		})
	}
}

// TestFileVectors는 files case마다 파일을 ReadFile로 path를 주어, ReadBytes로 그 byte와
// case path를 이름으로 주어 읽는다. 두 reader는 같은 rule과 위치를 내고 message는 각자
// 받은 이름을 쓴다.
func TestFileVectors(t *testing.T) {
	vectors := loadVectors(t)
	if len(vectors.Files) == 0 {
		t.Fatal("files cases are missing")
	}
	root := repositoryRoot(t)
	for _, c := range vectors.Files {
		path := filepath.Join(root, "tests", "dbspec", c.Path)
		readers := []struct {
			kind, name string
			read       func() (string, []Diagnostic, error)
		}{
			{"file", path, func() (string, []Diagnostic, error) { return ReadFile(path) }},
			{"bytes", c.Path, func() (string, []Diagnostic, error) {
				raw, err := os.ReadFile(path)
				if err != nil {
					return "", nil, err
				}
				text, diagnostics := ReadBytes(c.Path, raw)
				return text, diagnostics, nil
			}},
		}
		for _, reader := range readers {
			id := "files/" + c.ID + "/" + reader.kind
			t.Run(id, func(t *testing.T) {
				runTimed(t, id, 5*time.Second, func() error {
					text, diagnostics, err := reader.read()
					if err != nil {
						return err
					}
					return expectFileRead(path, reader.name, text, diagnostics, c.Errors)
				})
			})
		}
	}
}

// fileMessages는 file reader와 byte check가 rule마다 쓰는 message다.
var fileMessages = map[string]string{RuleSignature: " is not a dbspec document", RuleEncoding: " is not valid UTF-8"}

// expectFileRead는 한 reader의 결과를 files case와 비교한다. errors가 있으면 text 없이 그
// diagnostic만, 없으면 파일 byte와 같은 text가 parse되고 그대로 emit되어야 한다.
func expectFileRead(path, name, text string, diagnostics []Diagnostic, want []vectorError) error {
	if len(want) > 0 {
		if text != "" {
			return fmt.Errorf("the reader returned text with diagnostics")
		}
		got := make([]vectorError, len(diagnostics))
		for i, d := range diagnostics {
			if message := name + fileMessages[d.Rule]; d.Message != message {
				return fmt.Errorf("message = %q, want %q", d.Message, message)
			}
			got[i] = vectorError{Line: d.Line, Column: d.Column, Rule: d.Rule}
		}
		if fmt.Sprint(got) != fmt.Sprint(want) {
			return fmt.Errorf("diagnostics = %+v, want %+v", got, want)
		}
		return nil
	}
	if len(diagnostics) != 0 {
		return fmt.Errorf("unexpected diagnostics %+v", diagnostics)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if text != string(raw) {
		return fmt.Errorf("the reader text differs from the file bytes")
	}
	got, err := emitStable(text, nil)
	if err != nil {
		return err
	}
	if got != text {
		return fmt.Errorf("emission differs:\ngot:\n%s\nwant:\n%s", got, text)
	}
	return nil
}

// expectDiagnostics는 text를 parse해 모든 diagnostic의 rule, 줄, 칸을 순서대로 want와
// 비교한다.
func expectDiagnostics(text string, set map[string]string, want []vectorError) error {
	document, diagnostics := Parse(text, set)
	if document != nil {
		return fmt.Errorf("Parse returned a document for an invalid source")
	}
	got := make([]vectorError, len(diagnostics))
	for i, d := range diagnostics {
		if d.Message == "" {
			return fmt.Errorf("diagnostic %+v has no message", d)
		}
		got[i] = vectorError{Line: d.Line, Column: d.Column, Rule: d.Rule}
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		return fmt.Errorf("diagnostics = %+v, want %+v (messages %+v)", got, want, diagnostics)
	}
	return nil
}
