// Command go는 모든 공유 case, stress 문서, statement vector, plan vector, Mermaid vector의
// Go dbspec 결과를 tests/dbspec/compare/check.mjs의 줄 형식으로 출력한다.
//
// Usage: go run ./tests/dbspec/compare/go <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>
package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
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

// fileCase는 cases.json 기준 상대 경로로 파일을 이름 짓는 files case다.
type fileCase struct {
	ID   string
	Path string
}

// sharedCases는 tests/dbspec/cases.json이다.
type sharedCases struct {
	Canonical []testCase
	Normalize []testCase
	Invalid   []testCase
	Hashes    []hashCase
	Files     []fileCase
}

// join은 줄을 LF로, crlf이면 CRLF로, mixed이면 CRLF와 LF를 번갈아 마지막 줄 끝 없이 잇는다.
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

// write는 text의 diagnostic을, 없으면 그 emission을 출력한다.
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

// writeManifest는 case 문서 집합의 hash와 text를, 또는 문서나 집합의 diagnostic을 출력한다.
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

// writeRender는 case 문서 집합의 statement를 dialect마다, 또는 문서나 집합의 diagnostic을
// 출력한다.
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

// writeDiagnostics는 diagnostic을 출력한다. plan, chain, compare diagnostic은 모든 client가
// 공유하는 message로 끝나고, target이나 source의 schema diagnostic은 그렇지 않다.
func writeDiagnostics(out *bufio.Writer, diagnostics []dbspec.Diagnostic) {
	for _, d := range diagnostics {
		if d.Rule == dbspec.RulePlan || d.Rule == dbspec.RuleChain || d.Rule == dbspec.RuleCompare {
			fmt.Fprintf(out, "! %s %d %d %s\n", d.Rule, d.Line, d.Column, d.Message)
		} else {
			fmt.Fprintf(out, "! %s %d %d\n", d.Rule, d.Line, d.Column)
		}
	}
}

// planVectors는 tests/dbspec/plans.json이다(docs/plans.md).
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

// planSource는 plan case의 source schema를 읽고 빈 schema이면 nil을 돌려주며, diagnostic이
// 있으면 출력하고 false를 알린다.
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

// writeChanges는 change를 "| kind table name"으로 출력한다.
func writeChanges(out *bufio.Writer, changes []dbspec.Change) {
	for _, c := range changes {
		fmt.Fprintf(out, "| %s %s %s\n", c.Kind, c.Table, c.Name)
	}
}

// writePlans는 plan case마다 emit한 plan, change, dialect별 statement를, invalid case마다
// diagnostic을, chain case마다 chain 순서나 diagnostic을, parse case마다 diagnostic이나 emit한
// plan을, comparison마다 차이나 diagnostic을 출력한다.
// writeStep은 step 하나를 statement 줄과 그 속성 줄로 쓴다(tests/dbspec/compare/check.mjs).
func writeStep(out *bufio.Writer, s dbspec.PlanStep) {
	fmt.Fprintf(out, "| %s\n", s.Statement)
	switch {
	case s.Finalize:
		fmt.Fprintln(out, "  finalize")
	case s.Rollback != "":
		fmt.Fprintf(out, "  rollback: %s\n", s.Rollback)
	default:
		fmt.Fprintf(out, "  irreversible: %s\n", s.Irreversible)
	}
	fmt.Fprintf(out, "  effect: %s\n", s.Effect)
	if s.Restore != "" {
		fmt.Fprintf(out, "  restore: %s\n", s.Restore)
	}
	if s.RollbackRestore != "" {
		fmt.Fprintf(out, "  rollback_restore: %s\n", s.RollbackRestore)
	}
	if s.Restore != "" || s.RollbackRestore != "" {
		fmt.Fprintf(out, "  restore_if: %s\n", s.RestoreIf)
	}
	for _, c := range s.NullChecks {
		def := "none"
		if c.HasDefault {
			def = c.Default
		}
		fmt.Fprintf(out, "  null_check: %s %s %s\n", c.Table, c.Column, def)
	}
}

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
			steps, diagnostics := dbspec.PlanSteps(source, p, dialect)
			writeDiagnostics(out, diagnostics)
			for _, s := range steps {
				writeStep(out, s)
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

// mermaidVectors는 tests/dbspec/mermaid.json이다(docs/mermaid.md).
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

// writeDropped는 export나 import가 뺀 것을 "= kind<TAB>table<TAB>name"으로 출력한다.
// 이유는 비교하지 않는다.
func writeDropped(out *bufio.Writer, dropped []dbspec.Unsupported) {
	for _, u := range dropped {
		fmt.Fprintf(out, "= %s\t%s\t%s\n", u.Kind, u.Table, u.Name)
	}
}

// writeExport는 문서의 Mermaid text와 빠진 객체를 출력한다.
func writeExport(out *bufio.Writer, d *dbspec.Document) string {
	text, dropped := dbspec.ExportMermaid(d)
	for _, line := range strings.Split(text, "\n") {
		fmt.Fprintf(out, "| %s\n", line)
	}
	writeDropped(out, dropped)
	return text
}

// writeImport는 import의 emit한 문서와 빠진 객체를, 또는 diagnostic을 출력한다.
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

// writeMermaid는 모든 export case, import와 invalid case, round trip case를 출력한다. round
// trip case는 문서의 export, 그다음 "<case>/import"와 그 export의 import다.
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
		source, diagnostics, err := dbspec.ReadFile(c.Path)
		if err != nil {
			return err
		}
		if len(diagnostics) > 0 {
			writeDiagnostics(out, diagnostics)
			continue
		}
		d, diagnostics := dbspec.Parse(source, nil)
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

// writeFile은 path를 dbspec.ReadFile로 읽어 diagnostic과 그 message를, 없으면 그
// text의 emission을 출력한다. message 앞의 path는 "<path>"로 쓴다.
func writeFile(out *bufio.Writer, path string) error {
	text, diagnostics, err := dbspec.ReadFile(path)
	if err != nil {
		return err
	}
	if len(diagnostics) == 0 {
		write(out, text, nil, false)
		return nil
	}
	for _, d := range diagnostics {
		fmt.Fprintf(out, "! %s %d %d\n", d.Rule, d.Line, d.Column)
		if rest, ok := strings.CutPrefix(d.Message, path); ok {
			fmt.Fprintf(out, "= <path>%s\n", rest)
		} else {
			fmt.Fprintf(out, "= %s\n", d.Message)
		}
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
	stress, diagnostics, err := dbspec.ReadFile(os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if len(diagnostics) > 0 {
		fmt.Fprintln(os.Stderr, diagnostics[0].Message)
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
	write(out, stress, nil, true)
	for _, c := range all.Files {
		fmt.Fprintf(out, "files/%s\n", c.ID)
		if err := writeFile(out, filepath.Join(filepath.Dir(os.Args[1]), c.Path)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
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
