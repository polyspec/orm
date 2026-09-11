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
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: ormgen build <files.mmd...> --out schema/schema.json")
	os.Exit(2)
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
