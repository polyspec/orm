// orm-gen makes Go models from a dbspec document set and, from docs/spec/errors.yaml, each
// language's error code file.
//
//	orm-gen gen --set <dbspec-set.json> --lang go --out <directory> [--scan <package pattern>...] [--check]
//	orm-gen errors --lang go|php|rust|typescript|python --out <file> [--yaml docs/spec/errors.yaml]
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/generator"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "gen":
		gen(os.Args[2:])
	case "errors":
		errorsCmd(os.Args[2:])
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: orm-gen gen --set <dbspec-set.json> --lang go --out <directory> [--scan <package pattern>...] [--check]")
	fmt.Fprintln(os.Stderr, "       orm-gen errors --lang go|php|rust|typescript|python --out <file> [--yaml docs/spec/errors.yaml]")
	os.Exit(2)
}

func gen(args []string) {
	fs := flag.NewFlagSet("gen", flag.ExitOnError)
	set := fs.String("set", "", "set file dbspec-set.json of the document set (required)")
	lang := fs.String("lang", "go", "go")
	out := fs.String("out", "", "output directory (required)")
	var scan stringList
	fs.Var(&scan, "scan", "Go package pattern whose model calls are generated (repeatable)")
	check := fs.Bool("check", false, "compare the generated files with --out without writing")
	// With ExitOnError, Parse ends the process on a bad flag itself; an error it returns is the same usage error.
	if err := fs.Parse(args); err != nil {
		usage()
	}
	if *set == "" || *out == "" {
		usage()
	}
	if *lang != "go" {
		fail(fmt.Errorf("lang %q: orm-gen of the Go module generates Go; PHP, Rust, and TypeScript use their own generators", *lang))
	}
	// The set file is read before anything is written: every error of the set
	// file and every diagnostic of its files is printed, and nothing is written.
	m, err := runtimemodel.LoadSetFile(*set)
	var invalid *runtimemodel.SetLoadError
	if errors.As(err, &invalid) {
		for _, problem := range invalid.Problems {
			fmt.Fprintf(os.Stderr, "orm-gen: %s\n", problem)
		}
		os.Exit(1)
	}
	if err != nil {
		fail(err)
	}
	// A failed generation leaves the output directory unchanged and exits with 1. When the scanned package does not compile,
	// it exits with 3. A check that finds a difference
	// prints the difference and exits with 1.
	options := generator.Options{Model: m, OutputDir: *out, Scan: scan}
	var lines []string
	if *check {
		lines, err = generator.Check(options)
	} else {
		err = generator.Generate(options)
	}
	var scanned *generator.ScannedSourceError
	if err != nil && !errors.As(err, &scanned) {
		fail(err)
	}
	if *check {
		reportCheck(lines)
	} else {
		fmt.Printf("orm-gen: %d entities → %s (go)\n", len(m.Order), *out)
	}
	if scanned != nil {
		fmt.Fprintf(os.Stderr, "orm-gen: %v\n", err)
		os.Exit(3)
	}
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "orm-gen: %v\n", err)
	os.Exit(1)
}

// reportCheck prints the check's lines, and exits with 1 if there are any lines.
func reportCheck(lines []string) {
	for _, line := range lines {
		fmt.Println(line)
	}
	if len(lines) > 0 {
		os.Exit(1)
	}
}

// stringList collects a repeated string flag.
type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }
