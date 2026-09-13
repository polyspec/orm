package schema

import (
	"bytes"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

func TestCRUDEmittersProduceDeterministicValidSource(t *testing.T) {
	data, err := os.ReadFile("../../tests/fixtures/crud/schema.mmd")
	if err != nil {
		t.Fatal(err)
	}
	diagram, err := Parse(string(data))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	crud, err := manifest.BuildCRUDManifest()
	if err != nil {
		t.Fatal(err)
	}
	var goOne, goTwo bytes.Buffer
	if err := crud.EmitGoWrapper(&goOne, "generated"); err != nil {
		t.Fatal(err)
	}
	if err := crud.EmitGoWrapper(&goTwo, "generated"); err != nil {
		t.Fatal(err)
	}
	if goOne.String() != goTwo.String() {
		t.Fatal("Go output is not deterministic")
	}
	if _, err := parser.ParseFile(token.NewFileSet(), "generated.go", goOne.Bytes(), parser.AllErrors); err != nil {
		t.Fatalf("generated Go is invalid: %v", err)
	}
	var ts bytes.Buffer
	if err := crud.EmitTypeScriptCRUD(&ts); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ts.String(), "export const crudRoutes") || !strings.Contains(ts.String(), "product.item") {
		t.Fatal("generated TypeScript contract is incomplete")
	}
}

func TestCRUDRejectsMissingRoleOnPhysicalFK(t *testing.T) {
	source := `erDiagram
  parent {
    bigint seq PK
  }
  child {
    bigint seq PK
    bigint parent_seq FK
  }
  parent ||--o{ child : parent_seq`
	diagram, err := Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	if err := manifest.ValidateORM(); err == nil || !strings.Contains(err.Error(), "no orm:field role") {
		t.Fatalf("missing FK role was accepted: %v", err)
	}
}
