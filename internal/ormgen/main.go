// ormgen: schema tooling. S1 scope: build (Mermaid → schema.json).
//
//	ormgen build  <schema/*.mmd...> --out schema/schema.json
package ormgen

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

func Main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "build":
		build(os.Args[2:])
	case "gen":
		gen(os.Args[2:])
	case "import":
		importCmd(os.Args[2:])
	case "validate":
		validateCmd(os.Args[2:])
	case "errors":
		errorsCmd(os.Args[2:])
	case "ddl":
		ddlCmd(os.Args[2:])
	case "diff":
		diffCmd(os.Args[2:])
	case "migrate":
		migrateCmd(os.Args[2:])
	case "plan":
		planCmd(os.Args[2:])
	case "apply":
		applyCmd(os.Args[2:])
	case "recover":
		recoverCmd(os.Args[2:])
	case "rollback":
		rollbackCmd(os.Args[2:])
	case "verify":
		verifyCmd(os.Args[2:])
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: ormgen build <files.mmd...> --out schema/schema.json [--check]")
	fmt.Fprintln(os.Stderr, "       ormgen gen --schema schema/schema.json --lang go --out <directory> [--scan <package pattern>...] [--check]")
	fmt.Fprintln(os.Stderr, "       ormgen import --dsn <dsn> --out schema/app.mmd [--tables a,b]")
	fmt.Fprintln(os.Stderr, "       ormgen validate --dsn <dsn> --schema schema/schema.json")
	fmt.Fprintln(os.Stderr, "       ormgen errors --lang go|php|rust --out <file>")
	fmt.Fprintln(os.Stderr, "       ormgen ddl --schema <source> --dialect mysql|postgres|sqlite --out <file.sql>")
	fmt.Fprintln(os.Stderr, "       ormgen diff --from <source> --to <source> --dialect mysql|postgres|sqlite --out <file.sql> [--allow-destructive]")
	fmt.Fprintln(os.Stderr, "       ormgen migrate --dsn <dsn> --schema <source> [--migration-id id] [--dry-run]")
	fmt.Fprintln(os.Stderr, "       ormgen plan --from <source> --to <source> --dialect mysql|postgres|sqlite --out migration.json")
	fmt.Fprintln(os.Stderr, "       source: schema.mmd | schema.json | ormgen.sql | db:<dsn>")
	fmt.Fprintln(os.Stderr, "       ormgen apply --plan migration.json --dsn <dsn> --schema schema.json [--allow-destructive]")
	fmt.Fprintln(os.Stderr, "       ormgen recover (--plan migration.json | --migration-id id) --dsn <dsn> --schema schema.json")
	fmt.Fprintln(os.Stderr, "       ormgen rollback --plan YYYYMMDD-name.json --dsn <dsn> [--allow-destructive]")
	fmt.Fprintln(os.Stderr, "       ormgen verify --dsn <dsn> --schema schema/schema.json")
	os.Exit(2)
}

func gen(args []string) {
	fs := flag.NewFlagSet("gen", flag.ExitOnError)
	schemaPath := fs.String("schema", "", "schema.json (required)")
	lang := fs.String("lang", "go", "go")
	out := fs.String("out", "", "output directory (required)")
	var scan stringList
	fs.Var(&scan, "scan", "Go package pattern whose model calls are generated (repeatable)")
	check := fs.Bool("check", false, "compare the generated files with --out without writing")
	fs.Parse(args)
	if *schemaPath == "" || *out == "" {
		usage()
	}
	if *lang != "go" {
		fail(fmt.Errorf("lang %q: ormgen generates Go; PHP, Rust, and TypeScript use their own generators", *lang))
	}
	js, err := os.ReadFile(*schemaPath)
	if err != nil {
		fail(err)
	}
	m, err := schema.Load(js)
	if err != nil {
		fail(err)
	}
	// A generation failure leaves the output directory unchanged and exits
	// with status 1. Scanned packages that do not compile with the written
	// models exit with status 3. A check that finds a difference prints it and
	// exits with status 1.
	var lines []string
	if *check {
		lines, err = checkGo(m, *out, scan)
	} else {
		err = genGo(m, *out, scan)
	}
	var consumer *ConsumerError
	if err != nil && !errors.As(err, &consumer) {
		fail(err)
	}
	if *check {
		reportCheck(lines)
	} else {
		fmt.Printf("ormgen: %d entities → %s (go)\n", len(m.Order), *out)
	}
	if consumer != nil {
		fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
		os.Exit(3)
	}
}

func build(args []string) {
	fs := flag.NewFlagSet("build", flag.ExitOnError)
	out := fs.String("out", "", "output schema.json path (required)")
	check := fs.Bool("check", false, "compare the built manifest with --out without writing")
	// Accept flags anywhere: `ormgen build a.mmd --out x` and `ormgen build --out x a.mmd`.
	var flags, positional []string
	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") {
			flags = append(flags, args[i])
			if !strings.Contains(args[i], "=") && strings.TrimLeft(args[i], "-") != "check" && i+1 < len(args) {
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
	js = append(js, '\n')
	if *check {
		current, err := os.ReadFile(*out)
		switch {
		case errors.Is(err, os.ErrNotExist):
			reportCheck([]string{"missing: " + *out})
		case err != nil:
			fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
			os.Exit(1)
		case !bytes.Equal(current, js):
			reportCheck([]string{"differs: " + *out})
		}
		return
	}
	if err := os.WriteFile(*out, js, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("ormgen: %d entities → %s (schema_hash %s)\n", len(m.Order), *out, m.SchemaHash)
}

// reportCheck prints the lines of a check and exits with status 1 when there
// is a line.
func reportCheck(lines []string) {
	for _, line := range lines {
		fmt.Println(line)
	}
	if len(lines) > 0 {
		os.Exit(1)
	}
}

// stringList collects a repeatable string flag.
type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }
