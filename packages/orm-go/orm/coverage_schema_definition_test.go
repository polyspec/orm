//go:build featurecoverage

package orm_test

import (
	"os"
	"path/filepath"
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
		document, diagnostics := dbspec.Parse(text, set)
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
