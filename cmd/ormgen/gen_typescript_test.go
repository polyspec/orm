package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/polyspec/orm/contracts"
	"github.com/polyspec/orm/engine/schema"
)

func TestTypeScriptGenerationIsCurrent(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "../.."))
	source, err := os.ReadFile(filepath.Join(root, "schema/schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Load(source)
	if err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	if err := genTypeScript(manifest, out); err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join(out, "entities.ts"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, "clients/typescript/src/gen/entities.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("clients/typescript/src/gen/entities.ts differs from ormgen output")
	}
	if err := contracts.GenerateInterfaces(manifest, "typescript", out, ""); err != nil {
		t.Fatal(err)
	}
	wantInterfaces, err := os.ReadFile(filepath.Join(out, "interfaces.ts"))
	if err != nil {
		t.Fatal(err)
	}
	gotInterfaces, err := os.ReadFile(filepath.Join(root, "clients/typescript/src/gen/interfaces.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotInterfaces, wantInterfaces) {
		t.Fatal("clients/typescript/src/gen/interfaces.ts differs from contract output")
	}
	text := string(got)
	for _, forbidden := range []string{"joinUser(", "relationUser(", "oneBy"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("generated relation-name shortcut %q is forbidden", forbidden)
		}
	}
	for _, required := range []string{"joinServiceSeqWithSeq(", "relationServiceSeqWithSeq(", "public join(child: QueryCore)", "getCountByServiceSeq("} {
		if !strings.Contains(text, required) {
			t.Fatalf("generated common method %q is missing", required)
		}
	}
}
