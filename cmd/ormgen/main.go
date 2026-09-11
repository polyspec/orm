// ormgen: schema tooling. S1 scope: build (Mermaid → schema.json).
//
//	ormgen build  <schema/*.mmd...> --out schema/schema.json
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/maxkwon/orm/engine/schema"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "build":
		build(os.Args[2:])
	case "gen":
		gen(os.Args[2:])
	case "tokens":
		tokens(os.Args[2:])
	case "import":
		importCmd(os.Args[2:])
	case "validate":
		validateCmd(os.Args[2:])
	case "errors":
		errorsCmd(os.Args[2:])
	case "ddl":
		ddlCmd(os.Args[2:])
	case "check":
		checkCmd(os.Args[2:])
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: ormgen build <files.mmd...> --out schema/schema.json")
	fmt.Fprintln(os.Stderr, "       ormgen gen --schema schema/schema.json --lang go --out clients/go/gen")
	fmt.Fprintln(os.Stderr, "       ormgen tokens --schema schema/schema.json [--print] <file.go> <file.php> <file.rs>...")
	fmt.Fprintln(os.Stderr, "       ormgen import --dsn <dsn> --out schema/app.mmd [--tables a,b]")
	fmt.Fprintln(os.Stderr, "       ormgen validate --dsn <dsn> --schema schema/schema.json")
	fmt.Fprintln(os.Stderr, "       ormgen errors --lang go|php|rust --out <file>")
	fmt.Fprintln(os.Stderr, "       ormgen ddl --schema schema/schema.json --dialect mysql|postgres|sqlite --out <file.sql>")
	fmt.Fprintln(os.Stderr, "       ormgen check --lang php [--top n] <dir>...")
	os.Exit(2)
}

func gen(args []string) {
	fs := flag.NewFlagSet("gen", flag.ExitOnError)
	schemaPath := fs.String("schema", "", "schema.json (required)")
	lang := fs.String("lang", "", "go|php|rust (required)")
	out := fs.String("out", "", "output directory (required)")
	ns := fs.String("namespace", "App\\Orm", "PHP namespace")
	fs.Parse(args)
	if *schemaPath == "" || *lang == "" || *out == "" {
		usage()
	}
	js, err := os.ReadFile(*schemaPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
		os.Exit(1)
	}
	m, err := schema.Load(js)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
		os.Exit(1)
	}
	switch *lang {
	case "go":
		err = genGo(m, *out)
	case "php":
		err = genPHP(m, *out, *ns)
	case "rust":
		err = genRust(m, *out)
	default:
		err = fmt.Errorf("lang %q not implemented", *lang)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("ormgen: %d entities → %s (%s)\n", len(m.Order), *out, *lang)
}

func build(args []string) {
	fs := flag.NewFlagSet("build", flag.ExitOnError)
	out := fs.String("out", "", "output schema.json path (required)")
	// Accept flags anywhere: `ormgen build a.mmd --out x` and `ormgen build --out x a.mmd`.
	var flags, positional []string
	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") {
			flags = append(flags, args[i])
			if !strings.Contains(args[i], "=") && i+1 < len(args) {
				flags = append(flags, args[i+1])
				i++
			}
			continue
		}
		positional = append(positional, args[i])
	}
	fs.Parse(flags)
	if *out == "" || len(positional) == 0 {
		usage()
	}
	var files []string
	for _, a := range positional {
		matches, err := filepath.Glob(a)
		if err != nil || len(matches) == 0 {
			fmt.Fprintf(os.Stderr, "ormgen: no such file: %s\n", a)
			os.Exit(1)
		}
		files = append(files, matches...)
	}
	sort.Strings(files)
	var diagrams []*schema.Diagram
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
			os.Exit(1)
		}
		d, err := schema.Parse(string(src))
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s:%v\n", f, err)
			os.Exit(1)
		}
		diagrams = append(diagrams, d)
	}
	m, err := schema.Build(diagrams...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
		os.Exit(1)
	}
	for _, w := range m.Warnings() {
		fmt.Fprintln(os.Stderr, "warning:", w)
	}
	js, err := m.MarshalIndent()
	if err != nil {
		fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, append(js, '\n'), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("ormgen: %d entities → %s (schema_hash %s)\n", len(m.Order), *out, m.SchemaHash)
}
