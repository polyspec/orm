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
	"sort"
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

type hashCase struct {
	ID        string              `json:"id"`
	Documents map[string][]string `json:"documents"`
}

type cases struct {
	Canonical []testCase `json:"canonical"`
	Normalize []testCase `json:"normalize"`
	Invalid   []testCase `json:"invalid"`
	Hashes    []hashCase `json:"hashes"`
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

// writeManifest prints the hashes and texts of the case's document set, or
// the diagnostics of a document or of the set.
func writeManifest(out *bufio.Writer, c hashCase) {
	names := make([]string, 0, len(c.Documents))
	for name := range c.Documents {
		names = append(names, name)
	}
	sort.Strings(names)
	var documents []*dbspec.Document
	for _, name := range names {
		set := map[string]string{}
		for other, lines := range c.Documents {
			if other != name {
				set[other] = join(lines, false, false)
			}
		}
		document, diagnostics := dbspec.Parse(join(c.Documents[name], false, false), set)
		if len(diagnostics) > 0 {
			for _, d := range diagnostics {
				fmt.Fprintf(out, "! %s %d %d\n", d.Rule, d.Line, d.Column)
			}
			return
		}
		documents = append(documents, document)
	}
	manifest, diagnostics := dbspec.ManifestOf(documents)
	if len(diagnostics) > 0 {
		for _, d := range diagnostics {
			fmt.Fprintf(out, "! %s %d %d\n", d.Rule, d.Line, d.Column)
		}
		return
	}
	fmt.Fprintf(out, "= manifestHash %s\n= schemaHash %s\n= manifestText\n", manifest.ManifestHash, manifest.SchemaHash)
	for _, line := range strings.Split(manifest.ManifestText, "\n") {
		fmt.Fprintf(out, "| %s\n", line)
	}
	fmt.Fprintln(out, "= schemaText")
	for _, line := range strings.Split(manifest.SchemaText, "\n") {
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
	for _, c := range all.Hashes {
		fmt.Fprintf(out, "hashes/%s\n", c.ID)
		writeManifest(out, c)
	}
	if err := out.Flush(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
