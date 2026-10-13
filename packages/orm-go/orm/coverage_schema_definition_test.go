//go:build featurecoverage

package orm_test

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
)

// schemaDocuments는 fixture input이 repository root 기준으로 나열한 dbspec
// document를 읽어 text와 parse한 document를 같은 순서로 반환한다.
func schemaDocuments(t *testing.T, c fixtureCase) ([]string, []*dbspec.Document) {
	t.Helper()
	var input struct {
		Documents []string `json:"documents"`
	}
	decodeFixture(t, c.Input, &input)
	if len(input.Documents) == 0 {
		t.Fatalf("case %s lists no documents", c.ID)
	}
	texts := make([]string, len(input.Documents))
	set := map[string]string{}
	for i, path := range input.Documents {
		b, err := os.ReadFile(filepath.Join("..", "..", "..", filepath.FromSlash(path)))
		if err != nil {
			t.Fatal(err)
		}
		texts[i] = string(b)
		header, _, _ := strings.Cut(texts[i], "\n")
		fields := strings.Fields(header)
		if len(fields) != 3 || fields[0] != "dbspec" {
			t.Fatalf("%s has no dbspec header: %q", path, header)
		}
		set[fields[2]] = texts[i]
	}
	documents := make([]*dbspec.Document, len(texts))
	for i, text := range texts {
		document, _, diagnostics := dbspec.Parse(text, set)
		if len(diagnostics) > 0 {
			t.Fatalf("%s: %s", input.Documents[i], runtimemodel.DiagnosticsError(diagnostics))
		}
		documents[i] = document
	}
	return texts, documents
}

// TestCoverageDbspecEmitRoundTrip는 각 document를 parse해 emit하면 원문이
// byte 단위로 그대로인지 확인한다.
func TestCoverageDbspecEmitRoundTrip(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	c := featureFixture(t, "schema_definition", "dbspec_emit_round_trip", "parse_emit")
	var expected struct {
		Identical bool `json:"identical"`
	}
	decodeFixture(t, c.Expected, &expected)
	texts, documents := schemaDocuments(t, c)
	for i, document := range documents {
		if emitted := dbspec.Emit(document); (emitted == texts[i]) != expected.Identical {
			t.Fatalf("document %s: emit identical = %t, want %t\n%s", document.Name, emitted == texts[i], expected.Identical, emitted)
		}
	}
}

// TestCoverageDbspecManifestHash는 document set의 manifest hash가 fixture의
// 값인지 확인한다.
func TestCoverageDbspecManifestHash(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	c := featureFixture(t, "schema_definition", "dbspec_manifest_hash", "manifest")
	var expected struct {
		ManifestHash string `json:"manifest_hash"`
	}
	decodeFixture(t, c.Expected, &expected)
	_, documents := schemaDocuments(t, c)
	manifest, diagnostics := dbspec.ManifestOf(documents)
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	if expected.ManifestHash == "" || manifest.ManifestHash != expected.ManifestHash {
		t.Fatalf("manifest hash = %s, want %s", manifest.ManifestHash, expected.ManifestHash)
	}
}

// TestCoverageDbspecRenderDdl는 document set을 각 dialect로 render한
// statement가 fixture의 배열과 같은지 확인한다.
func TestCoverageDbspecRenderDdl(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	c := featureFixture(t, "schema_definition", "dbspec_render_ddl", "render")
	var expected struct {
		MySQL    []string `json:"mysql"`
		Postgres []string `json:"postgres"`
		SQLite   []string `json:"sqlite"`
	}
	decodeFixture(t, c.Expected, &expected)
	_, documents := schemaDocuments(t, c)
	for dialect, want := range map[string][]string{"mysql": expected.MySQL, "postgres": expected.Postgres, "sqlite": expected.SQLite} {
		got, diagnostics := dbspec.Render(documents, dbspec.Dialect(dialect))
		if len(diagnostics) > 0 {
			t.Fatalf("%s: %s", dialect, runtimemodel.DiagnosticsError(diagnostics))
		}
		if len(want) == 0 || !slices.Equal(got, want) {
			t.Fatalf("%s statements:\n got %q\nwant %q", dialect, got, want)
		}
	}
}

// fixtureText reads the input of a format case: the lines of one document, joined with LF and a final line end.
func fixtureText(t *testing.T, c fixtureCase) string {
	t.Helper()
	var input struct {
		Text []string `json:"text"`
	}
	decodeFixture(t, c.Input, &input)
	if len(input.Text) == 0 {
		t.Fatalf("case %s has no text", c.ID)
	}
	return strings.Join(input.Text, "\n") + "\n"
}

// TestCoverageDbspecAnalyzeTokens checks that the analysis of each document holds the
// result of Parse unchanged and the tokens of the fixture.
func TestCoverageDbspecAnalyzeTokens(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	c := featureFixture(t, "schema_definition", "dbspec_analyze_tokens", "analyze")
	var expected struct {
		Tokens [][4]any `json:"tokens"`
	}
	decodeFixture(t, c.Expected, &expected)
	texts, documents := schemaDocuments(t, c)
	for i, text := range texts {
		analysis := dbspec.Analyze(text, nil)
		_, positions, _ := dbspec.Parse(text, nil)
		if len(analysis.Diagnostics) > 0 {
			t.Fatal(runtimemodel.DiagnosticsError(analysis.Diagnostics))
		}
		if dbspec.Emit(analysis.Document) != dbspec.Emit(documents[i]) || !reflect.DeepEqual(analysis.Positions, positions) {
			t.Fatalf("document %s: the analysis differs from the parse", documents[i].Name)
		}
		got := make([][4]any, len(analysis.Tokens))
		for j, token := range analysis.Tokens {
			got[j] = [4]any{float64(token.Line), float64(token.Start), float64(token.End), token.Class}
		}
		if len(expected.Tokens) == 0 || !reflect.DeepEqual(got, expected.Tokens) {
			t.Fatalf("document %s tokens:\n got %v\nwant %v", documents[i].Name, got, expected.Tokens)
		}
	}
}

// TestCoverageDbspecFormat checks that the text formats to the fixture text and that
// the formatted text is its own format.
func TestCoverageDbspecFormat(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	c := featureFixture(t, "schema_definition", "dbspec_format", "format")
	var expected struct {
		Text []string `json:"text"`
	}
	decodeFixture(t, c.Expected, &expected)
	formatted, diagnostics := dbspec.Format(fixtureText(t, c), nil)
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	if want := strings.Join(expected.Text, "\n") + "\n"; formatted != want {
		t.Fatalf("formatted text:\n%s\nwant\n%s", formatted, want)
	}
	if again, _ := dbspec.Format(formatted, nil); again != formatted {
		t.Fatalf("the format of the formatted text differs:\n%s", again)
	}
}

// TestCoverageDbspecFormatRefusal checks that a text with a diagnostic is refused with
// the fixture diagnostics and no text.
func TestCoverageDbspecFormatRefusal(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	c := featureFixture(t, "schema_definition", "dbspec_format_refusal", "format")
	var expected struct {
		Diagnostics []struct {
			Rule   string `json:"rule"`
			Line   int    `json:"line"`
			Column int    `json:"column"`
		} `json:"diagnostics"`
	}
	decodeFixture(t, c.Expected, &expected)
	formatted, diagnostics := dbspec.Format(fixtureText(t, c), nil)
	if formatted != "" {
		t.Fatalf("a document with a diagnostic was rewritten:\n%s", formatted)
	}
	if len(diagnostics) != len(expected.Diagnostics) || len(diagnostics) == 0 {
		t.Fatalf("diagnostics = %+v, want %+v", diagnostics, expected.Diagnostics)
	}
	for i, d := range diagnostics {
		want := expected.Diagnostics[i]
		if string(d.Rule) != want.Rule || d.Line != want.Line || d.Column != want.Column {
			t.Fatalf("diagnostic %d = %s %d %d, want %+v", i, d.Rule, d.Line, d.Column, want)
		}
	}
}

// TestCoverageDbspecParsePositions checks that Parse returns the declaration positions
// of the fixture for each document.
func TestCoverageDbspecParsePositions(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	c := featureFixture(t, "schema_definition", "dbspec_parse_positions", "parse_positions")
	var expected struct {
		Positions []struct {
			Kind   string   `json:"kind"`
			Path   []string `json:"path"`
			Line   int      `json:"line"`
			Column int      `json:"column"`
		} `json:"positions"`
	}
	decodeFixture(t, c.Expected, &expected)
	texts, documents := schemaDocuments(t, c)
	for i, text := range texts {
		_, positions, diagnostics := dbspec.Parse(text, nil)
		if len(diagnostics) > 0 {
			t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
		}
		if len(positions) != len(expected.Positions) || len(positions) == 0 {
			t.Fatalf("document %s: %d positions, want %d", documents[i].Name, len(positions), len(expected.Positions))
		}
		for j, p := range positions {
			want := expected.Positions[j]
			if p.Kind != want.Kind || !slices.Equal(p.Path, want.Path) || p.Line != want.Line || p.Column != want.Column {
				t.Fatalf("document %s position %d = %+v, want %+v", documents[i].Name, j, p, want)
			}
		}
	}
}
