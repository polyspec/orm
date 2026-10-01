// Command go prints the Go dbspec result of every shared case and of the
// stress document in the line format of tests/dbspec/compare/check.mjs.
//
// Usage: go run ./tests/dbspec/compare/go <cases.json> <stress document>
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/polyspec/orm/engine/dbspec"
)

type testCase struct {
	ID        string              `json:"id"`
	Main      string              `json:"main"`
	Documents map[string][]string `json:"documents"`
	CRLF      bool                `json:"crlf"`
	Mixed     bool                `json:"mixed"`
}

type cases struct {
	Canonical []testCase `json:"canonical"`
	Normalize []testCase `json:"normalize"`
	Invalid   []testCase `json:"invalid"`
}

// join writes the lines with LF, with CRLF when crlf is true, or with
// alternating CRLF and LF and no final line end when mixed is true.
func join(lines []string, crlf, mixed bool) string {
	var b strings.Builder
	for i, line := range lines {
		b.WriteString(line)
		switch {
		case mixed && i == len(lines)-1:
		case mixed && i%2 == 0, !mixed && crlf:
			b.WriteString("\r\n")
		default:
			b.WriteString("\n")
		}
	}
	return b.String()
}

// write prints the diagnostics of text, or its emission when it has none.
func write(out *bufio.Writer, text string, set map[string]string, stress bool) {
	document, diagnostics := dbspec.Parse(text, set)
	if len(diagnostics) > 0 {
		for _, d := range diagnostics {
			fmt.Fprintf(out, "! %s %d %d\n", d.Rule, d.Line, d.Column)
		}
		return
	}
	emitted := dbspec.Emit(document)
	if stress {
		if emitted == text {
			fmt.Fprintln(out, "= unchanged")
		} else {
			fmt.Fprintln(out, "= changed")
		}
		return
	}
	for _, line := range strings.Split(emitted, "\n") {
		fmt.Fprintf(out, "| %s\n", line)
	}
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: go run ./tests/dbspec/compare/go <cases.json> <stress document>")
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var all cases
	if err := json.Unmarshal(raw, &all); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	stress, err := os.ReadFile(os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	out := bufio.NewWriter(os.Stdout)
	for _, kind := range []struct {
		name  string
		cases []testCase
	}{{"canonical", all.Canonical}, {"normalize", all.Normalize}, {"invalid", all.Invalid}} {
		for _, c := range kind.cases {
			set := map[string]string{}
			for name, lines := range c.Documents {
				if name != c.Main {
					set[name] = join(lines, c.CRLF, c.Mixed)
				}
			}
			fmt.Fprintf(out, "%s/%s\n", kind.name, c.ID)
			write(out, join(c.Documents[c.Main], c.CRLF, c.Mixed), set, false)
		}
	}
	fmt.Fprintln(out, "stress")
	write(out, string(stress), nil, true)
	if err := out.Flush(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
