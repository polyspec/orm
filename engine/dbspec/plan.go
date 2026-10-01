package dbspec

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// RulePlan과 RuleChain은 plan 문서와 plan chain의 diagnostic이다
// (docs/plans.md).
const (
	RulePlan  = "plan"
	RuleChain = "chain"
)

// Plan은 parse한 plan 문서다. From이 빈 문자열이면 빈 database에서 시작한다.
type Plan struct {
	Name          string
	From          string
	RenameTables  []TableRename
	RenameColumns []ColumnRename
	DropTables    []string
	DropColumns   []ColumnName
	// Schema는 target schema text를 parse한 문서이고 To는 그 schemaHash다.
	Schema *Document
	To     string
	// schemaText는 parse한 target schema text이며 EmitPlan이 그대로 쓴다.
	schemaText string
}

// TableRename은 `rename table <old> <new>`다.
type TableRename struct{ Old, New string }

// ColumnRename은 `rename column <table>.<old> <new>`이며 Table은 target 이름이다.
type ColumnRename struct{ Table, Old, New string }

// ColumnName은 `allow drop column <table>.<name>`의 source table과 column이다.
type ColumnName struct{ Table, Name string }

var (
	planHeader       = regexp.MustCompile(`^dbplan 1 ([a-z][a-z0-9_]*)$`)
	planFrom         = regexp.MustCompile(`^from (empty|sha256:[0-9a-f]{64})$`)
	planRenameTable  = regexp.MustCompile(`^rename table ([a-z][a-z0-9_]*) ([a-z][a-z0-9_]*)$`)
	planRenameColumn = regexp.MustCompile(`^rename column ([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*) ([a-z][a-z0-9_]*)$`)
	planDropTable    = regexp.MustCompile(`^allow drop table ([a-z][a-z0-9_]*)$`)
	planDropColumn   = regexp.MustCompile(`^allow drop column ([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$`)
)

// ParsePlan은 plan 문서를 읽는다. 잘못된 문서는 위치가 붙은 diagnostic이다.
func ParsePlan(text string) (*Plan, []Diagnostic) {
	if !strings.HasSuffix(text, "\n") {
		return nil, []Diagnostic{{Rule: RulePlan, Line: strings.Count(text, "\n") + 1, Column: 1, Message: "a plan ends with a line end"}}
	}
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	fail := func(line int, format string, args ...any) (*Plan, []Diagnostic) {
		return nil, []Diagnostic{{Rule: RulePlan, Line: line, Column: 1, Message: fmt.Sprintf(format, args...)}}
	}
	m := planHeader.FindStringSubmatch(lines[0])
	if m == nil || reservedWords[m[1]] || len(m[1]) > 63 {
		return fail(1, "the first line is exactly `dbplan 1 <name>`")
	}
	p := &Plan{Name: m[1]}
	if len(lines) < 2 {
		return fail(2, "the second line is `from empty` or `from <schemaHash>`")
	}
	f := planFrom.FindStringSubmatch(lines[1])
	if f == nil {
		return fail(2, "the second line is `from empty` or `from <schemaHash>`")
	}
	if f[1] != "empty" {
		p.From = f[1]
	}
	seen := map[string]int{}
	given := map[string]int{}
	i := 2
	for ; i < len(lines) && lines[i] != ""; i++ {
		line, n := lines[i], i+1
		if at, ok := seen[line]; ok {
			return fail(n, "line %d repeats this line", at)
		}
		seen[line] = n
		switch {
		case planRenameTable.MatchString(line):
			r := planRenameTable.FindStringSubmatch(line)
			if err := planNames(r[1:]); err != "" {
				return fail(n, "%s", err)
			}
			if at, ok := given["table "+r[2]]; ok {
				return fail(n, "line %d renames another table to %s", at, r[2])
			}
			given["table "+r[2]] = n
			p.RenameTables = append(p.RenameTables, TableRename{Old: r[1], New: r[2]})
		case planRenameColumn.MatchString(line):
			r := planRenameColumn.FindStringSubmatch(line)
			if err := planNames(r[1:]); err != "" {
				return fail(n, "%s", err)
			}
			key := "column " + r[1] + "." + r[3]
			if at, ok := given[key]; ok {
				return fail(n, "line %d renames another column to %s.%s", at, r[1], r[3])
			}
			given[key] = n
			p.RenameColumns = append(p.RenameColumns, ColumnRename{Table: r[1], Old: r[2], New: r[3]})
		case planDropTable.MatchString(line):
			r := planDropTable.FindStringSubmatch(line)
			if err := planNames(r[1:]); err != "" {
				return fail(n, "%s", err)
			}
			p.DropTables = append(p.DropTables, r[1])
		case planDropColumn.MatchString(line):
			r := planDropColumn.FindStringSubmatch(line)
			if err := planNames(r[1:]); err != "" {
				return fail(n, "%s", err)
			}
			p.DropColumns = append(p.DropColumns, ColumnName{Table: r[1], Name: r[2]})
		default:
			return fail(n, "a header line is `rename table`, `rename column`, `allow drop table` or `allow drop column`")
		}
	}
	if i >= len(lines) {
		return fail(i+1, "a blank line and the target schema text follow the header")
	}
	offset := i + 1
	schemaText := strings.Join(lines[offset:], "\n") + "\n"
	document, diagnostics := Parse(schemaText, nil)
	if len(diagnostics) > 0 {
		for k := range diagnostics {
			diagnostics[k].Line += offset
		}
		return nil, diagnostics
	}
	manifest, diagnostics := ManifestOf([]*Document{document})
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	if manifest.SchemaText != schemaText {
		return fail(offset+1, "the target is not a schema text: one document named schema in canonical form with its tables in name order and only the immutable and audit settings")
	}
	if manifest.SchemaHash == p.From {
		return fail(2, "the plan starts from its own target schema")
	}
	p.Schema, p.To, p.schemaText = document, manifest.SchemaHash, schemaText
	return p, nil
}

func planNames(names []string) string {
	for _, n := range names {
		if reservedWords[n] || len(n) > 63 {
			return fmt.Sprintf("name %q is reserved or longer than 63 bytes", n)
		}
	}
	return ""
}

// EmitPlan은 plan을 canonical 문서로 쓴다: rename table, rename column, allow
// drop table, allow drop column 순서로, 각각 이름 순이다.
func EmitPlan(p *Plan) string {
	var b strings.Builder
	b.WriteString("dbplan 1 " + p.Name + "\n")
	if p.From == "" {
		b.WriteString("from empty\n")
	} else {
		b.WriteString("from " + p.From + "\n")
	}
	var header []string
	for _, r := range sortedBy(p.RenameTables, func(r TableRename) string { return r.Old }) {
		header = append(header, "rename table "+r.Old+" "+r.New)
	}
	for _, r := range sortedBy(p.RenameColumns, func(r ColumnRename) string { return r.Table + "." + r.Old }) {
		header = append(header, "rename column "+r.Table+"."+r.Old+" "+r.New)
	}
	for _, t := range sortedBy(p.DropTables, func(t string) string { return t }) {
		header = append(header, "allow drop table "+t)
	}
	for _, c := range sortedBy(p.DropColumns, func(c ColumnName) string { return c.Table + "." + c.Name }) {
		header = append(header, "allow drop column "+c.Table+"."+c.Name)
	}
	for _, h := range header {
		b.WriteString(h + "\n")
	}
	b.WriteString("\n")
	b.WriteString(p.schemaText)
	return b.String()
}

// Chain은 plan들을 from empty에서 이어지는 순서로 돌려준다. plan이 없으면
// table이 없는 database의 빈 chain이다.
func Chain(plans []*Plan) ([]*Plan, []Diagnostic) {
	if len(plans) == 0 {
		return []*Plan{}, nil
	}
	byFrom := map[string][]*Plan{}
	for _, p := range plans {
		byFrom[p.From] = append(byFrom[p.From], p)
	}
	var out []Diagnostic
	froms := make([]string, 0, len(byFrom))
	for from := range byFrom {
		froms = append(froms, from)
	}
	slices.Sort(froms)
	for _, from := range froms {
		if ps := byFrom[from]; len(ps) > 1 {
			names := make([]string, len(ps))
			for i, p := range ps {
				names[i] = p.Name
			}
			slices.Sort(names)
			out = append(out, Diagnostic{Rule: RuleChain, Line: 1, Column: 1, Message: "plans " + strings.Join(names, ", ") + " start from the same schema"})
		}
	}
	if len(byFrom[""]) == 0 {
		out = append(out, Diagnostic{Rule: RuleChain, Line: 1, Column: 1, Message: "no plan starts from empty"})
	}
	if len(out) > 0 {
		return nil, out
	}
	var chain []*Plan
	visited := map[*Plan]bool{}
	for p := byFrom[""][0]; p != nil; {
		if visited[p] {
			return nil, []Diagnostic{{Rule: RuleChain, Line: 1, Column: 1, Message: "plan " + p.Name + " closes a cycle"}}
		}
		visited[p] = true
		chain = append(chain, p)
		next := byFrom[p.To]
		if len(next) == 0 {
			break
		}
		p = next[0]
	}
	var unreached []string
	for _, p := range plans {
		if !visited[p] {
			unreached = append(unreached, p.Name)
		}
	}
	if len(unreached) > 0 {
		slices.Sort(unreached)
		return nil, []Diagnostic{{Rule: RuleChain, Line: 1, Column: 1, Message: "no chain reaches plans " + strings.Join(unreached, ", ")}}
	}
	return chain, nil
}
