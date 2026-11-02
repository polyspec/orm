// Command go prints the Go dbspec results for all shared cases, stress documents, statement vectors, plan vectors, and Mermaid vectors
// in the line format of tests/dbspec/compare/check.mts. It then prints the positions cases, the analysis and format of each
// canonical, normalize and invalid case of the recipe files (in that order), and then of each case of syntax.json.
//
// Usage: go run ./packages/go/internal/dbspec/compare <tests/dbspec dir> <stress document> <ddl.json> <plan-cases.json> <mermaid.json>
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
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

// fileCase is the files case that names a file by its path relative to cases.json.
type fileCase struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

// sharedCases is tests/dbspec/cases.json.
type sharedCases struct {
	Canonical []testCase
	Normalize []testCase
	Invalid   []testCase
	Hashes    []hashCase
	Files     []fileCase
	Positions []positionCase
	Analyses  []analysis
}

// namedDocument is a document of a sets case with the name of its header.
type namedDocument struct {
	Name  string
	Lines []string
}

// positionCase is a positions case of cases.json: a main document and the other documents of its set.
type positionCase struct {
	ID        string
	Main      string
	Documents map[string][]string
}

// syntaxInput is the text and the declared document set of one analysis of syntax.json.
type syntaxInput struct {
	Text      string
	Documents map[string]string
}

// syntaxInputs gives the input of every analysis that syntax.json names, by its id, as
// scripts/dbspec/syntax-vectors.mts derives it from cases.json: the main document of each canonical, normalize and
// invalid case ("<section>.<id>"), each document of a sets case with the parsing documents and the other documents
// of the case by header name ("sets.<id>.<place>", 1-based), and each document of a hashes case with the others
// ("hashes.<id>.<name>").
func syntaxInputs(all sharedCases) map[string]syntaxInput {
	inputs := map[string]syntaxInput{}
	for _, kind := range caseKinds(all) {
		for _, c := range kind.cases {
			set := documentsExcept(c.Documents, c.Main, func(lines []string) string { return join(lines, c.CRLF, c.Mixed) })
			inputs[kind.name+"."+c.ID] = syntaxInput{Text: join(c.Documents[c.Main], c.CRLF, c.Mixed), Documents: set}
		}
	}
	return inputs
}

// writePositions prints each positions case: the declaration positions of its main document as
// "| kind<TAB>line<TAB>column<TAB>path..." lines, or its diagnostics.
func writePositions(out *output, cases []positionCase) {
	for _, c := range cases {
		out.printf("positions/%s\n", c.ID)
		set := map[string]string{}
		for name, lines := range c.Documents {
			if name != c.Main {
				set[name] = join(lines, false, false)
			}
		}
		_, positions, diagnostics := dbspec.Parse(join(c.Documents[c.Main], false, false), set)
		for _, d := range diagnostics {
			out.printf("! %s %d %d\n", d.Rule, d.Line, d.Column)
		}
		for _, p := range positions {
			out.printf("| %s\t%d\t%d\t%s\n", p.Kind, p.Line, p.Column, strings.Join(p.Path, "\t"))
		}
	}
}

// writeSyntax prints the analysis of one syntax case, its tokens ("| line start end class") and its diagnostics,
// then "syntax/<id>/format" and the formatted text or the diagnostics of the refusal.
func writeSyntax(out *output, id string, input syntaxInput) {
	out.printf("syntax/%s\n", id)
	analysis := dbspec.Analyze(input.Text, input.Documents)
	for _, t := range analysis.Tokens {
		out.printf("| %d %d %d %s\n", t.Line, t.Start, t.End, t.Class)
	}
	for _, d := range analysis.Diagnostics {
		out.printf("! %s %d %d\n", d.Rule, d.Line, d.Column)
	}
	out.printf("syntax/%s/format\n", id)
	text, diagnostics := dbspec.Format(input.Text, input.Documents)
	for _, d := range diagnostics {
		out.printf("! %s %d %d\n", d.Rule, d.Line, d.Column)
	}
	if len(diagnostics) == 0 {
		for _, line := range strings.Split(text, "\n") {
			out.printf("| %s\n", line)
		}
	}
}

// join joins lines with LF, with CRLF when crlf, and alternating CRLF and LF when mixed, with no line ending on the last line.
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

// write prints the diagnostic of text, or otherwise its emission.
func write(out *output, text string, set map[string]string, stress bool) {
	document, _, diagnostics := dbspec.Parse(text, set)
	if len(diagnostics) > 0 {
		for _, d := range diagnostics {
			out.printf("! %s %d %d\n", d.Rule, d.Line, d.Column)
		}
		return
	}
	emitted := dbspec.Emit(document)
	if stress {
		if emitted == text {
			out.println("= unchanged")
		} else {
			out.println("= changed")
		}
		return
	}
	for _, line := range strings.Split(emitted, "\n") {
		out.printf("| %s\n", line)
	}
}

// writeManifest prints the hash and text of the case document set, or the diagnostic of a document or set.
func writeManifest(out *output, c hashCase) {
	documents, ok := parseCaseDocuments(out, c, "")
	if !ok {
		return
	}
	manifest, diagnostics := dbspec.ManifestOf(documents)
	if len(diagnostics) > 0 {
		for _, d := range diagnostics {
			out.printf("! %s %d %d\n", d.Rule, d.Line, d.Column)
		}
		return
	}
	out.printf("= manifestHash %s\n= schemaHash %s\n= manifestText\n", manifest.ManifestHash, manifest.SchemaHash)
	for _, line := range strings.Split(manifest.ManifestText, "\n") {
		out.printf("| %s\n", line)
	}
	out.println("= schemaText")
	for _, line := range strings.Split(manifest.SchemaText, "\n") {
		out.printf("| %s\n", line)
	}
}

// writeRender prints the statements of the case document set per dialect, or the diagnostic of a document
// or set.
func writeRender(out *output, c hashCase) {
	documents, ok := parseCaseDocuments(out, c, fmt.Sprintf("render/%s\n", c.ID))
	if !ok {
		return
	}
	for _, dialect := range []dbspec.Dialect{dbspec.DialectMySQL, dbspec.DialectPostgres, dbspec.DialectSQLite} {
		out.printf("render/%s/%s\n", c.ID, dialect)
		statements, diagnostics := dbspec.Render(documents, dialect)
		for _, d := range diagnostics {
			out.printf("! %s %d %d\n", d.Rule, d.Line, d.Column)
		}
		for _, s := range statements {
			out.printf("| %s\n", s)
		}
	}
}

// writeDiagnostics prints the diagnostic. plan, chain, and compare diagnostics end with a message that all clients
// share, and schema diagnostics of the target or source do not.
func writeDiagnostics(out *output, diagnostics []dbspec.Diagnostic) {
	for _, d := range diagnostics {
		if d.Rule == dbspec.RulePlan || d.Rule == dbspec.RuleChain || d.Rule == dbspec.RuleCompare {
			out.printf("! %s %d %d %s\n", d.Rule, d.Line, d.Column, d.Message)
		} else {
			out.printf("! %s %d %d\n", d.Rule, d.Line, d.Column)
		}
	}
}

// planVectors is tests/dbspec/plan-cases.json (docs/spec/plans.md): its cases are read from the file itself, and its
// four validation sections are read from the recipes beside it (readPlans).
type planVectors struct {
	Cases   []planCase  `json:"-"`
	Invalid []planCase  `json:"-"`
	Chains  []chainCase `json:"-"`
	Parse   []parseCase `json:"-"`
	// Comparisons are the two schemas compared without a plan.
	Comparisons []comparisonCase `json:"-"`
}

type comparisonCase struct {
	ID     string   `json:"id"`
	Source []string `json:"source"`
	Target []string `json:"target"`
}

// If planCase's Source is nil, it is an empty schema.
type planCase struct {
	ID     string    `json:"id"`
	Source *[]string `json:"source"`
	Plan   []string  `json:"plan"`
}

type chainCase struct {
	ID    string     `json:"id"`
	Plans [][]string `json:"plans"`
}

type parseCase struct {
	ID   string   `json:"id"`
	Plan []string `json:"plan"`
}

// planSource reads the source schema of a plan case, returns nil if the schema is empty, and if there is a diagnostic
// prints it and reports false.
func planSource(out *output, lines *[]string) (*dbspec.Document, bool) {
	if lines == nil {
		return nil, true
	}
	document, _, diagnostics := dbspec.Parse(join(*lines, false, false), nil)
	if len(diagnostics) > 0 {
		writeDiagnostics(out, diagnostics)
		return nil, false
	}
	return document, true
}

// writeChanges prints each change as "| kind table name".
func writeChanges(out *output, changes []dbspec.Change) {
	for _, c := range changes {
		out.printf("| %s %s %s\n", c.Kind, c.Table, c.Name)
	}
}

// writePlans prints, for each plan case, the emitted plan, the changes, and the statements per dialect; for each invalid case, the
// diagnostic; for each chain case, the chain order or diagnostic; for each parse case, the diagnostic or the emitted
// plan; for each comparison, the differences or diagnostic.
// writeStep writes a step as a statement line and its attribute lines (tests/dbspec/compare/check.mts).
func writeStep(out *output, s dbspec.PlanStep) {
	out.printf("| %s\n", s.Statement)
	switch {
	case s.Finalize:
		out.println("  finalize")
	case s.Rollback != "":
		out.printf("  rollback: %s\n", s.Rollback)
	default:
		out.printf("  irreversible: %s\n", s.Irreversible)
	}
	out.printf("  effect: %s\n", s.Effect)
	if s.Restore != "" {
		out.printf("  restore: %s\n", s.Restore)
	}
	if s.RollbackRestore != "" {
		out.printf("  rollback_restore: %s\n", s.RollbackRestore)
	}
	if s.Restore != "" || s.RollbackRestore != "" {
		out.printf("  restore_if: %s\n", s.RestoreIf)
	}
	for _, c := range s.NullChecks {
		def := "none"
		if c.HasDefault {
			def = c.Default
		}
		out.printf("  null_check: %s %s %s\n", c.Table, c.Column, def)
	}
}

func writePlans(out *output, v planVectors) {
	for _, c := range v.Cases {
		out.printf("plans/cases/%s\n", c.ID)
		source, ok := planSource(out, c.Source)
		if !ok {
			continue
		}
		p, ok := parsePlanCase(out, c.Plan)
		if !ok {
			continue
		}
		writeEmittedPlan(out, p)
		out.printf("plans/cases/%s/changes\n", c.ID)
		changes, diagnostics := dbspec.Diff(source, p)
		writeDiagnostics(out, diagnostics)
		writeChanges(out, changes)
		for _, dialect := range []dbspec.Dialect{dbspec.DialectMySQL, dbspec.DialectPostgres, dbspec.DialectSQLite} {
			out.printf("plans/cases/%s/%s\n", c.ID, dialect)
			steps, diagnostics := dbspec.PlanSteps(source, p, dialect)
			writeDiagnostics(out, diagnostics)
			for _, s := range steps {
				writeStep(out, s)
			}
		}
	}
	for _, c := range v.Invalid {
		out.printf("plans/invalid/%s\n", c.ID)
		source, ok := planSource(out, c.Source)
		if !ok {
			continue
		}
		p, ok := parsePlanCase(out, c.Plan)
		if !ok {
			continue
		}
		changes, diagnostics := dbspec.Diff(source, p)
		writeDiagnostics(out, diagnostics)
		writeChanges(out, changes)
	}
	for _, c := range v.Chains {
		out.printf("plans/chains/%s\n", c.ID)
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
			out.printf("| %s\n", p.Name)
		}
	}
	for _, c := range v.Parse {
		out.printf("plans/parse/%s\n", c.ID)
		p, ok := parsePlanCase(out, c.Plan)
		if !ok {
			continue
		}
		writeEmittedPlan(out, p)
	}
	for _, c := range v.Comparisons {
		out.printf("plans/comparisons/%s\n", c.ID)
		source, _, sourceDiagnostics := dbspec.Parse(join(c.Source, false, false), nil)
		writeDiagnostics(out, sourceDiagnostics)
		target, _, targetDiagnostics := dbspec.Parse(join(c.Target, false, false), nil)
		writeDiagnostics(out, targetDiagnostics)
		if len(sourceDiagnostics) > 0 || len(targetDiagnostics) > 0 {
			continue
		}
		differences, diagnostics := dbspec.CompareSchemas(source, target)
		writeDiagnostics(out, diagnostics)
		for _, d := range differences {
			out.printf("| %s %s %s\n", d.Kind, d.Table, d.Name)
		}
	}
}

// writeDropped prints what export or import dropped as "= kind<TAB>table<TAB>name".
// The reason is not compared.
func writeDropped(out *output, dropped []dbspec.Unsupported) {
	for _, u := range dropped {
		out.printf("= %s\t%s\t%s\n", u.Kind, u.Table, u.Name)
	}
}

const (
	opExportMermaid = "dbspec.export_mermaid"
	opImportMermaid = "dbspec.import_mermaid"
)

// mermaidCategory is the category a case prints under: round_trip when it exports a file or imports a skeleton of one,
// export when it exports, invalid when its import expects errors, and import otherwise.
func mermaidCategory(c mermaidCase) string {
	export, invalid := false, false
	for _, s := range c.Steps {
		switch s.Op {
		case opExportMermaid:
			if s.Document != "" {
				return "round_trip"
			}
			export = true
		case opImportMermaid:
			if s.SkeletonOf != "" {
				return "round_trip"
			}
			if _, ok := s.Expect.None.Value["errors"]; ok {
				invalid = true
			}
		}
	}
	switch {
	case export:
		return "export"
	case invalid:
		return "invalid"
	default:
		return "import"
	}
}

// writeMermaid prints every case of the recipe under its category (mermaidCategory), then the output of each of its steps.
// dir is the directory of the recipe file, which path and skeleton_of are relative to.
func writeMermaid(out *output, v mermaidRecipe, dir string) error {
	for _, c := range v.Cases {
		category := mermaidCategory(c)
		out.printf("mermaid/%s/%s\n", category, c.ID)
		texts := map[string]string{}
	steps:
		for _, s := range c.Steps {
			switch s.Op {
			case opExportMermaid:
				text, ok, err := writeMermaidExport(out, s, dir)
				if err != nil {
					return err
				}
				if !ok {
					break steps
				}
				if s.As != "" {
					texts[s.As] = text
				}
			case opImportMermaid:
				if category == "round_trip" {
					out.printf("mermaid/round_trip/%s/import\n", c.ID)
				}
				if err := writeMermaidImport(out, s, texts, dir); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// writeMermaidExport prints the Mermaid text of an export step and the missing objects, and returns the text. A document
// with diagnostics writes them and reports false.
func writeMermaidExport(out *output, s mermaidStep, dir string) (string, bool, error) {
	// The inline text and the other documents of its set, or the .dbs file document (FCV-4).
	source := join(s.Text, false, false)
	set := map[string]string{}
	for name, lines := range s.Set {
		set[name] = join(lines, false, false)
	}
	if s.Document != "" {
		text, diagnostics, err := dbspec.ReadFile(filepath.Join(dir, s.Document))
		if err != nil {
			return "", false, err
		}
		if len(diagnostics) > 0 {
			writeDiagnostics(out, diagnostics)
			return "", false, nil
		}
		source, set = text, nil
	}
	d, _, diagnostics := dbspec.Parse(source, set)
	if len(diagnostics) > 0 {
		writeDiagnostics(out, diagnostics)
		return "", false, nil
	}
	text, dropped := dbspec.ExportMermaid(d)
	for _, line := range strings.Split(text, "\n") {
		out.printf("| %s\n", line)
	}
	writeDropped(out, dropped)
	return text, true, nil
}

// writeMermaidImport prints an import step: the emitted document and the missing objects, or the diagnostics; with
// skeleton_of, whether the skeleton of the imported document is that of the file, and the missing objects.
func writeMermaidImport(out *output, s mermaidStep, texts map[string]string, dir string) error {
	text, err := mermaidText(s.Mermaid, texts)
	if err != nil {
		return err
	}
	d, dropped, diagnostics := dbspec.ImportMermaid(text, s.Name)
	if len(diagnostics) > 0 {
		for _, g := range diagnostics {
			out.printf("! %s %d %d\n", g.Rule, g.Line, g.Column)
		}
		return nil
	}
	if s.SkeletonOf == "" {
		for _, line := range strings.Split(dbspec.Emit(d), "\n") {
			out.printf("| %s\n", line)
		}
		writeDropped(out, dropped)
		return nil
	}
	source, diagnostics, err := dbspec.ReadFile(filepath.Join(dir, s.SkeletonOf))
	if err != nil {
		return err
	}
	if len(diagnostics) > 0 {
		return fmt.Errorf("read %s: %v", s.SkeletonOf, diagnostics)
	}
	original, _, diagnostics := dbspec.Parse(source, nil)
	if len(diagnostics) > 0 {
		return fmt.Errorf("parse %s: %v", s.SkeletonOf, diagnostics)
	}
	out.printf("| same_skeleton\t%t\n", slices.Equal(mermaidSkeleton(original), mermaidSkeleton(d)))
	writeDropped(out, dropped)
	return nil
}

// mermaidText is the Mermaid text of an import: a plain text, or {"ref": "<step>.mermaid"} naming the text that the
// export step with as "<step>" bound.
func mermaidText(raw json.RawMessage, texts map[string]string) (string, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text, nil
	}
	var ref struct {
		Ref string `json:"ref"`
	}
	if err := json.Unmarshal(raw, &ref); err != nil {
		return "", fmt.Errorf("mermaid is neither a text nor a ref: %s", raw)
	}
	name, field, ok := strings.Cut(ref.Ref, ".")
	text, bound := texts[name]
	if !ok || field != "mermaid" || !bound {
		return "", fmt.Errorf("mermaid ref %s is not a bound export", ref.Ref)
	}
	return text, nil
}

// mermaidSkeleton writes the tables, columns, primary keys and foreign keys that Mermaid carries, in table-name order; foreign key
// actions are left out, since Mermaid does not carry them. It is the same as the skeleton of the Go recipe helper
// (packages/go/internal/recipe/mermaid.go), which this runner cannot import.
func mermaidSkeleton(d *dbspec.Document) []string {
	tables := slices.Clone(d.Tables)
	slices.SortFunc(tables, func(a, b dbspec.Table) int { return strings.Compare(a.Name, b.Name) })
	var out []string
	for _, t := range tables {
		out = append(out, "table "+t.Name)
		for _, c := range t.Columns {
			dflt := "-"
			if c.Default != nil {
				dflt = c.Default.Literal
				if c.Default.Now {
					dflt = "now"
				}
			}
			out = append(out, fmt.Sprintf("column %s %s null=%t identity=%t default=%s", c.Name, c.Type, c.Null, c.Identity, dflt))
		}
		out = append(out, "primary key "+strings.Join(t.PrimaryKey.Columns, ", "))
		fks := slices.Clone(t.ForeignKeys)
		slices.SortFunc(fks, func(a, b dbspec.ForeignKey) int { return strings.Compare(a.Name, b.Name) })
		for _, f := range fks {
			out = append(out, "foreign key "+f.Name+" ("+strings.Join(f.Columns, ", ")+") references "+f.Table+" ("+strings.Join(f.References, ", ")+")")
		}
	}
	return out
}

// writeFile reads a files case twice: once with path given to dbspec.ReadFile as "files/<id>",
// and once with the file bytes and case path given by name to dbspec.ReadBytes as "files/<id>/bytes". Each result
// is a diagnostic and message (the name replaced with "<name>"), or otherwise the emission.
func writeFile(out *output, id, path, name string) error {
	out.printf("files/%s\n", id)
	text, diagnostics, err := dbspec.ReadFile(path)
	if err != nil {
		return err
	}
	writeRead(out, text, diagnostics, path)
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	out.printf("files/%s/bytes\n", id)
	text, diagnostics = dbspec.ReadBytes(name, raw)
	writeRead(out, text, diagnostics, name)
	return nil
}

// writeRead prints the diagnostic and message of the reader result, or otherwise the emission of text.
func writeRead(out *output, text string, diagnostics []dbspec.Diagnostic, name string) {
	if len(diagnostics) == 0 {
		write(out, text, nil, false)
		return
	}
	for _, d := range diagnostics {
		out.printf("! %s %d %d\n", d.Rule, d.Line, d.Column)
		if rest, ok := strings.CutPrefix(d.Message, name); ok {
			out.printf("= <name>%s\n", rest)
		} else {
			out.printf("= %s\n", d.Message)
		}
	}
}

func main() {
	if len(os.Args) != 6 {
		fmt.Fprintln(os.Stderr, "usage: go run ./packages/go/internal/dbspec/compare <tests/dbspec dir> <stress document> <ddl.json> <plan-cases.json> <mermaid.json>")
		os.Exit(2)
	}
	dir := os.Args[1]
	all, err := readCases(dir)
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
	out := &output{w: bufio.NewWriter(os.Stdout)}
	for _, kind := range caseKinds(all) {
		for _, c := range kind.cases {
			set := documentsExcept(c.Documents, c.Main, func(lines []string) string { return join(lines, c.CRLF, c.Mixed) })
			out.printf("%s/%s\n", kind.name, c.ID)
			write(out, join(c.Documents[c.Main], c.CRLF, c.Mixed), set, false)
		}
	}
	out.println("stress")
	write(out, stress, nil, true)
	for _, c := range all.Files {
		if err := writeFile(out, c.ID, filepath.Join(dir, c.Path), c.Path); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	for _, c := range all.Hashes {
		out.printf("hashes/%s\n", c.ID)
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
	if err := writeMermaid(out, mermaid, filepath.Dir(os.Args[5])); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	writePositions(out, all.Positions)
	inputs := syntaxInputs(all)
	for _, kind := range caseKinds(all) {
		for _, c := range kind.cases {
			id := kind.name + "." + c.ID
			writeSyntax(out, id, inputs[id])
		}
	}
	for _, a := range all.Analyses {
		writeSyntax(out, a.id, a.input)
	}
	if err := out.flush(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// output is the buffered standard output of the command. It keeps the first write error, stops writing after it, and
// returns it from flush, so that a failed write fails the command.
type output struct {
	w   *bufio.Writer
	err error
}

func (o *output) printf(format string, a ...any) {
	if o.err == nil {
		_, o.err = fmt.Fprintf(o.w, format, a...)
	}
}

func (o *output) println(a ...any) {
	if o.err == nil {
		_, o.err = fmt.Fprintln(o.w, a...)
	}
}

func (o *output) flush() error {
	if o.err != nil {
		return o.err
	}
	return o.w.Flush()
}

// documentsExcept returns the documents of a case other than name, each as the
// text that text makes of its lines.
func documentsExcept(docs map[string][]string, name string, text func([]string) string) map[string]string {
	set := map[string]string{}
	for other, lines := range docs {
		if other != name {
			set[other] = text(lines)
		}
	}
	return set
}

// caseKind is one kind of the shared cases, with its name in the output.
type caseKind struct {
	name  string
	cases []testCase
}

// caseKinds returns the kinds of the shared cases in output order.
func caseKinds(all sharedCases) []caseKind {
	return []caseKind{{"canonical", all.Canonical}, {"normalize", all.Normalize}, {"invalid", all.Invalid}}
}

// sortedNames returns the names of the documents of a case, sorted.
func sortedNames(docs map[string][]string) []string {
	names := make([]string, 0, len(docs))
	for name := range docs {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// parsePlanCase parses the lines of a plan; a plan with diagnostics writes them
// and reports false.
func parsePlanCase(out *output, lines []string) (*dbspec.Plan, bool) {
	p, diagnostics := dbspec.ParsePlan(join(lines, false, false))
	if len(diagnostics) > 0 {
		writeDiagnostics(out, diagnostics)
		return nil, false
	}
	return p, true
}

// writeEmittedPlan writes the emitted text of a plan, line by line.
func writeEmittedPlan(out *output, p *dbspec.Plan) {
	for _, line := range strings.Split(dbspec.EmitPlan(p), "\n") {
		out.printf("| %s\n", line)
	}
}

// parseNamedDocument parses the document of a case named name against the other
// documents of the case, and returns it with its diagnostics.
func parseNamedDocument(c hashCase, name string) (*dbspec.Document, []dbspec.Diagnostic) {
	set := documentsExcept(c.Documents, name, func(lines []string) string { return join(lines, false, false) })
	document, _, diagnostics := dbspec.Parse(join(c.Documents[name], false, false), set)
	return document, diagnostics
}

// parseCaseDocuments parses the documents of a case in name order. When one has
// diagnostics, it writes header (when it is not empty) and the diagnostics, and
// reports false.
func parseCaseDocuments(out *output, c hashCase, header string) ([]*dbspec.Document, bool) {
	var documents []*dbspec.Document
	for _, name := range sortedNames(c.Documents) {
		document, diagnostics := parseNamedDocument(c, name)
		if len(diagnostics) > 0 {
			if header != "" {
				out.printf("%s", header)
			}
			for _, d := range diagnostics {
				out.printf("! %s %d %d\n", d.Rule, d.Line, d.Column)
			}
			return nil, false
		}
		documents = append(documents, document)
	}
	return documents, true
}
