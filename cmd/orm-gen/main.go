// orm-gen은 dbspec document set에서 Go model을 만들고 docs/errors.yaml에서 각
// 언어의 오류 코드 file을 만든다.
//
//	orm-gen gen --document <file.dbspec>... --lang go --out <directory> [--scan <package pattern>...] [--check]
//	orm-gen errors --lang go|php|rust --out <file> [--yaml docs/errors.yaml]
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/generator"
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
	fmt.Fprintln(os.Stderr, "usage: orm-gen gen --document <file.dbspec>... --lang go --out <directory> [--scan <package pattern>...] [--check]")
	fmt.Fprintln(os.Stderr, "       orm-gen errors --lang go|php|rust --out <file> [--yaml docs/errors.yaml]")
	os.Exit(2)
}

func gen(args []string) {
	fs := flag.NewFlagSet("gen", flag.ExitOnError)
	var documents stringList
	fs.Var(&documents, "document", "dbspec document of the document set (repeatable, required)")
	lang := fs.String("lang", "go", "go")
	out := fs.String("out", "", "output directory (required)")
	var scan stringList
	fs.Var(&scan, "scan", "Go package pattern whose model calls are generated (repeatable)")
	check := fs.Bool("check", false, "compare the generated files with --out without writing")
	fs.Parse(args)
	if len(documents) == 0 || *out == "" {
		usage()
	}
	if *lang != "go" {
		fail(fmt.Errorf("lang %q: orm-gen of the Go module generates Go; PHP, Rust, and TypeScript use their own generators", *lang))
	}
	m, err := runtimemodel.LoadFiles(documents...)
	if err != nil {
		fail(err)
	}
	// 생성 실패는 output directory를 바꾸지 않고 1로 끝난다. 생성된 model로
	// scan한 package가 compile되지 않으면 3으로 끝난다. 차이를 찾은 check는
	// 차이를 출력하고 1로 끝난다.
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

// reportCheck는 check의 줄을 출력하고 줄이 있으면 1로 끝난다.
func reportCheck(lines []string) {
	for _, line := range lines {
		fmt.Println(line)
	}
	if len(lines) > 0 {
		os.Exit(1)
	}
}

// stringList는 반복되는 string flag를 모은다.
type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }
