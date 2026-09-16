package generator

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func TestGenerateUsesCanonicalManifestForGoClient(t *testing.T) {
	document, err := schema.Parse(`erDiagram
  sample {
    bigint seq PK "auto"
  }
`)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(document)
	if err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	if err := Generate(Options{Manifest: manifest, Language: Go, OutputDir: out}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(out, "sample.go")); err != nil {
		t.Fatalf("generated ORM client is missing: %v", err)
	}
}
