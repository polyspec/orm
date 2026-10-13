package generator

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestGoGeneratesKeyPrefixMethodsWithoutScan checks that the methods of every
// prefix of a key come from the schema, whether or not a scanned call names
// them: Card has an index on audit_seq, and CardHistory an index on seq.
func TestGoGeneratesKeyPrefixMethodsWithoutScan(t *testing.T) {
	document, err := os.ReadFile(filepath.Join("..", "contracts", "fixtures", "audit_columns.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	m := namesManifest(t, string(document))
	out := t.TempDir()
	if err := generateGo(m, out, "model", nil); err != nil {
		t.Fatal(err)
	}
	var generated strings.Builder
	entries, err := os.ReadDir(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		body, err := os.ReadFile(filepath.Join(out, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		generated.Write(body)
	}
	for _, want := range []string{"func (x *CardModel) AuditSeq", "func (x *CardHistoryModel) Seq"} {
		if !strings.Contains(generated.String(), want) {
			t.Errorf("the generated models lack %q, a method of a key prefix without a scanned call", want)
		}
	}
}
