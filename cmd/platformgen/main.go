// Command platformgen validates the generic CRUD metadata extension and emits
// the deterministic intermediate manifest consumed by platform profiles.
// It deliberately has no database or SQL execution capability.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "build" {
		fmt.Fprintln(os.Stderr, "usage: platformgen build --schema schema.mmd [--out crud.json] [--lang manifest|go|php|rust|typescript]")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("build", flag.ExitOnError)
	source := fs.String("schema", "", "Mermaid or generated schema JSON")
	out := fs.String("out", "", "output path; stdout when omitted")
	lang := fs.String("lang", "manifest", "output language: manifest, go, php, rust, or typescript")
	fs.Parse(os.Args[2:])
	if *source == "" {
		fail("--schema is required")
	}
	b, err := os.ReadFile(*source)
	if err != nil {
		fail("read %s: %v", *source, err)
	}
	var manifest *schema.Manifest
	if ext := filepath.Ext(*source); ext == ".mmd" || ext == ".mermaid" {
		d, e := schema.Parse(string(b))
		if e != nil {
			fail("parse %s: %v", *source, e)
		}
		manifest, err = schema.Build(d)
	} else {
		manifest, err = schema.Load(b)
	}
	if err != nil {
		fail("build %s: %v", *source, err)
	}
	crud, err := manifest.BuildCRUDManifest()
	if err != nil {
		fail("validate %s: %v", *source, err)
	}
	var result []byte
	var buffer strings.Builder
	switch *lang {
	case "manifest":
		result, err = crud.MarshalIndent()
	case "go":
		err = crud.EmitGoWrapper(&buffer, "generated")
		result = []byte(buffer.String())
	case "typescript":
		err = crud.EmitTypeScriptCRUD(&buffer)
	case "php":
		err = crud.EmitPHPCRUD(&buffer)
	case "rust":
		err = crud.EmitRustCRUD(&buffer)
		result = []byte(buffer.String())
	default:
		fail("unsupported language %q", *lang)
	}
	if err != nil {
		fail("encode %s output: %v", *lang, err)
	}
	if !strings.HasSuffix(string(result), "\n") {
		result = append(result, '\n')
	}
	if *out == "" {
		_, _ = os.Stdout.Write(result)
		return
	}
	if err := os.WriteFile(*out, result, 0o644); err != nil {
		fail("write %s: %v", *out, err)
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "platformgen: "+format+"\n", args...)
	os.Exit(1)
}
