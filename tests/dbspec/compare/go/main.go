// Command go prints the Go dbspec result of every shared case, of the
// stress document, of the statement vectors, of the plan vectors and of the
// Mermaid vectors in the line format of tests/dbspec/compare/check.mjs.
//
// Usage: go run ./tests/dbspec/compare/go <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>
package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/polyspec/orm/engine/dbspec"
)

type testCase struct {
	ID        string
	Main      string
	Documents map[string][]string
	CRLF      bool
	Mixed     bool
}

type hashCase struct {
	ID        string
	Documents map[string][]string
}

// sharedCases는 tests/dbspec/cases.json이다.
type sharedCases struct {
	Canonical []testCase
	Normalize []testCase
	Invalid   []testCase
	Hashes    []hashCase
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

// writeRender prints the statements of the case's document set in every
// dialect, or the diagnostics of a document or of the set.
func writeRender(out *bufio.Writer, c hashCase) {
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
			fmt.Fprintf(out, "render/%s\n", c.ID)
			for _, d := range diagnostics {
				fmt.Fprintf(out, "! %s %d %d\n", d.Rule, d.Line, d.Column)
			}
			return
		}
		documents = append(documents, document)
	}
	for _, dialect := range []dbspec.Dialect{dbspec.DialectMySQL, dbspec.DialectPostgres, dbspec.DialectSQLite} {
		fmt.Fprintf(out, "render/%s/%s\n", c.ID, dialect)
		statements, diagnostics := dbspec.Render(documents, dialect)
		for _, d := range diagnostics {
			fmt.Fprintf(out, "! %s %d %d\n", d.Rule, d.Line, d.Column)
		}
		for _, s := range statements {
			fmt.Fprintf(out, "| %s\n", s)
		}
	}
}

// writeDiagnostics prints diagnostics; a plan or chain diagnostic ends with
// its message, which every client shares, and a schema diagnostic of the
// target or source does not.
func writeDiagnostics(out *bufio.Writer, diagnostics []dbspec.Diagnostic) {
	for _, d := range diagnostics {
		if d.Rule == dbspec.RulePlan || d.Rule == dbspec.RuleChain || d.Rule == dbspec.RuleCompare {
			fmt.Fprintf(out, "! %s %d %d %s\n", d.Rule, d.Line, d.Column, d.Message)
		} else {
			fmt.Fprintf(out, "! %s %d %d\n", d.Rule, d.Line, d.Column)
		}
	}
}

// planVectors is tests/dbspec/plans.json (docs/plans.md).
type planVectors struct {
	Cases   []planCase
	Invalid []planCase
	Chains  []chainCase
	Parse   []parseCase
	// Comparisons는 plan 없이 비교하는 두 schema다.
	Comparisons []comparisonCase
}

type comparisonCase struct {
	ID     string
	Source []string
	Target []string
}

// planCase의 Source가 nil이면 빈 schema이다.
type planCase struct {
	ID     string
	Source *[]string
	Plan   []string
}

type chainCase struct {
	ID    string
	Plans [][]string
}

type parseCase struct {
	ID   string
	Plan []string
}

// planSource parses the source schema of a plan case, nil for the empty
// schema, or prints its diagnostics and reports false.
func planSource(out *bufio.Writer, lines *[]string) (*dbspec.Document, bool) {
	if lines == nil {
		return nil, true
	}
	document, diagnostics := dbspec.Parse(join(*lines, false, false), nil)
	if len(diagnostics) > 0 {
		writeDiagnostics(out, diagnostics)
		return nil, false
	}
	return document, true
}

// writeChanges prints the changes as "| kind table name".
func writeChanges(out *bufio.Writer, changes []dbspec.Change) {
	for _, c := range changes {
		fmt.Fprintf(out, "| %s %s %s\n", c.Kind, c.Table, c.Name)
	}
}

// writePlans prints, for every plan case, the emitted plan, the changes and
// the statements of each dialect; for every invalid case its diagnostics; for
// every chain case the chain order or its diagnostics; and for every parse
// case its diagnostics or the emitted plan.
func writePlans(out *bufio.Writer, v planVectors) {
	for _, c := range v.Cases {
		fmt.Fprintf(out, "plans/cases/%s\n", c.ID)
		source, ok := planSource(out, c.Source)
		if !ok {
			continue
		}
		p, diagnostics := dbspec.ParsePlan(join(c.Plan, false, false))
		if len(diagnostics) > 0 {
			writeDiagnostics(out, diagnostics)
			continue
		}
		for _, line := range strings.Split(dbspec.EmitPlan(p), "\n") {
			fmt.Fprintf(out, "| %s\n", line)
		}
		fmt.Fprintf(out, "plans/cases/%s/changes\n", c.ID)
		changes, diagnostics := dbspec.Diff(source, p)
		writeDiagnostics(out, diagnostics)
		writeChanges(out, changes)
		for _, dialect := range []dbspec.Dialect{dbspec.DialectMySQL, dbspec.DialectPostgres, dbspec.DialectSQLite} {
			fmt.Fprintf(out, "plans/cases/%s/%s\n", c.ID, dialect)
			statements, diagnostics := dbspec.PlanStatements(source, p, dialect)
			writeDiagnostics(out, diagnostics)
			for _, s := range statements {
				fmt.Fprintf(out, "| %s\n", s)
			}
		}
	}
	for _, c := range v.Invalid {
		fmt.Fprintf(out, "plans/invalid/%s\n", c.ID)
		source, ok := planSource(out, c.Source)
		if !ok {
			continue
		}
		p, diagnostics := dbspec.ParsePlan(join(c.Plan, false, false))
		if len(diagnostics) > 0 {
			writeDiagnostics(out, diagnostics)
			continue
		}
		changes, diagnostics := dbspec.Diff(source, p)
		writeDiagnostics(out, diagnostics)
		writeChanges(out, changes)
	}
	for _, c := range v.Chains {
		fmt.Fprintf(out, "plans/chains/%s\n", c.ID)
		var plans []*dbspec.Plan
		parsed := true
		for _, lines := range c.Plans {
			p, diagnostics := dbspec.ParsePlan(join(lines, false, false))
			writeDiagnostics(out, diagnostics)
			parsed = parsed && len(diagnostics) == 0
			plans = append(plans, p)
		}
		if !parsed {
			continue
		}
		chain, diagnostics := dbspec.Chain(plans)
		writeDiagnostics(out, diagnostics)
		for _, p := range chain {
			fmt.Fprintf(out, "| %s\n", p.Name)
		}
	}
	for _, c := range v.Parse {
		fmt.Fprintf(out, "plans/parse/%s\n", c.ID)
		p, diagnostics := dbspec.ParsePlan(join(c.Plan, false, false))
		if len(diagnostics) > 0 {
			writeDiagnostics(out, diagnostics)
			continue
		}
		for _, line := range strings.Split(dbspec.EmitPlan(p), "\n") {
			fmt.Fprintf(out, "| %s\n", line)
		}
	}
	for _, c := range v.Comparisons {
		fmt.Fprintf(out, "plans/comparisons/%s\n", c.ID)
		source, sourceDiagnostics := dbspec.Parse(join(c.Source, false, false), nil)
		writeDiagnostics(out, sourceDiagnostics)
		target, targetDiagnostics := dbspec.Parse(join(c.Target, false, false), nil)
		writeDiagnostics(out, targetDiagnostics)
		if len(sourceDiagnostics) > 0 || len(targetDiagnostics) > 0 {
			continue
		}
		differences, diagnostics := dbspec.CompareSchemas(source, target)
		writeDiagnostics(out, diagnostics)
		for _, d := range differences {
			fmt.Fprintf(out, "| %s %s %s\n", d.Kind, d.Table, d.Name)
		}
	}
}

// mermaidVectors is tests/dbspec/mermaid.json (docs/mermaid.md).
type mermaidVectors struct {
	Export    []exportCase
	Import    []importCase
	Invalid   []importCase
	RoundTrip []roundTripCase
}

type exportCase struct {
	ID        string
	Document  []string
	Documents map[string][]string
}

type importCase struct {
	ID      string
	Mermaid []string
}

type roundTripCase struct {
	ID   string
	Path string
}

// writeDropped prints what an export or import left out as
// "= kind<TAB>table<TAB>name"; reasons are not compared.
func writeDropped(out *bufio.Writer, dropped []dbspec.Unsupported) {
	for _, u := range dropped {
		fmt.Fprintf(out, "= %s\t%s\t%s\n", u.Kind, u.Table, u.Name)
	}
}

// writeExport prints the Mermaid text and the dropped objects of a document.
func writeExport(out *bufio.Writer, d *dbspec.Document) string {
	text, dropped := dbspec.ExportMermaid(d)
	for _, line := range strings.Split(text, "\n") {
		fmt.Fprintf(out, "| %s\n", line)
	}
	writeDropped(out, dropped)
	return text
}

// writeImport prints the emitted document and the dropped objects of an
// import, or its diagnostics.
func writeImport(out *bufio.Writer, text string) {
	d, dropped, diagnostics := dbspec.ImportMermaid(text, "imported")
	if len(diagnostics) > 0 {
		writeDiagnostics(out, diagnostics)
		return
	}
	for _, line := range strings.Split(dbspec.Emit(d), "\n") {
		fmt.Fprintf(out, "| %s\n", line)
	}
	writeDropped(out, dropped)
}

// writeMermaid prints every export case, every import and invalid case, and
// every round trip case: the export of its document, then "<case>/import"
// with the import of that export.
func writeMermaid(out *bufio.Writer, v mermaidVectors) error {
	for _, c := range v.Export {
		fmt.Fprintf(out, "mermaid/export/%s\n", c.ID)
		set := map[string]string{}
		for name, lines := range c.Documents {
			set[name] = join(lines, false, false)
		}
		d, diagnostics := dbspec.Parse(join(c.Document, false, false), set)
		if len(diagnostics) > 0 {
			writeDiagnostics(out, diagnostics)
			continue
		}
		writeExport(out, d)
	}
	for _, c := range v.Import {
		fmt.Fprintf(out, "mermaid/import/%s\n", c.ID)
		writeImport(out, join(c.Mermaid, false, false))
	}
	for _, c := range v.Invalid {
		fmt.Fprintf(out, "mermaid/invalid/%s\n", c.ID)
		writeImport(out, join(c.Mermaid, false, false))
	}
	for _, c := range v.RoundTrip {
		fmt.Fprintf(out, "mermaid/round_trip/%s\n", c.ID)
		source, err := os.ReadFile(c.Path)
		if err != nil {
			return err
		}
		d, diagnostics := dbspec.Parse(string(source), nil)
		if len(diagnostics) > 0 {
			writeDiagnostics(out, diagnostics)
			continue
		}
		text := writeExport(out, d)
		fmt.Fprintf(out, "mermaid/round_trip/%s/import\n", c.ID)
		writeImport(out, text)
	}
	return nil
}

func main() {
	if len(os.Args) != 6 {
		fmt.Fprintln(os.Stderr, "usage: go run ./tests/dbspec/compare/go <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>")
		os.Exit(2)
	}
	all, err := readCases(os.Args[1])
	if err != nil {
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
	ddl, err := readDDL(os.Args[3])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, c := range ddl {
		writeRender(out, c)
	}
	plans, err := readPlans(os.Args[4])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	writePlans(out, plans)
	mermaid, err := readMermaid(os.Args[5])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := writeMermaid(out, mermaid); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := out.Flush(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
