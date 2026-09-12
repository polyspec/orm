// ormgen tokens: parity lint. Extracts the statement tokens (heads, predicates,
// joins, terminals, …) from Go/PHP/Rust/TypeScript sources, maps each language's spelling
// back to the canonical camelCase token, and diffs the sequences. Sources that
// express the same statements must produce identical token streams.
//
//	ormgen tokens --schema schema/schema.json [--print] a.go b.php c.rs
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

// vocabulary is every token the generators emit, in canonical form.
type vocabulary struct {
	heads     map[string]bool // Battle, ServiceMember …
	terminals map[string]bool // value-only execution methods
	navs      map[string]bool // relation names used as `<rel>(fn)` (≥1 arg; zero-arg is the row accessor)
	other     map[string]bool // everything else
}

func buildVocabulary(m *schema.Manifest) *vocabulary {
	v := &vocabulary{heads: map[string]bool{}, terminals: map[string]bool{}, navs: map[string]bool{}, other: map[string]bool{}}
	for _, t := range []string{"get", "gets", "one", "all", "count", "getCount", "getsCount", "paginate", "insert", "update", "updateOptimistic", "delete", "deleteCascade", "save", "sql", "rawAll"} {
		v.terminals[t] = true
	}
	for _, t := range []string{"and", "or", "on", "where", "expr", "limit", "distinct", "selectAll", "selectNone", "selectExpr", "orderByExpr", "groupByExpr",
		"using", "flatten", "limitPerParent", "dropChildKey", "noCascadeDelete", "keyByFn", "transaction", "onDuplicateSetAll", "having", "raw"} {
		v.other[t] = true
	}
	for _, name := range m.Order {
		e := m.Entities[name]
		v.heads[pascal(e.Name)] = true
		for _, pk := range e.PK {
			v.terminals["oneBy"+pascal(pk)] = true
			v.terminals["getBy"+pascal(pk)] = true
		}
		seenUnique := map[string]bool{}
		for _, cols := range e.Unique {
			key := strings.Join(cols, "\x1f")
			if seenUnique[key] || len(cols) == 0 || (len(cols) == 1 && cols[0] == e.PK[0]) {
				continue
			}
			seenUnique[key] = true
			v.terminals["getBy"+finderMethod(cols)] = true
		}
		for _, c := range e.Columns {
			f := pascal(c.Name)
			if allowed(c, "eq") {
				v.terminals["getsBy"+f] = true
				v.terminals["getCountBy"+f] = true
			}
			for _, o := range opsFor(c) {
				v.other[lowerFirst(f)+o.Suffix] = true
				if o.Op == "eq" {
					v.other[lowerFirst(f)] = true
				}
			}
			for _, o := range colOpsFor(c) {
				v.other[lowerFirst(f)+o.Suffix] = true
			}
			for _, p := range []string{"select", "unselect", "orderBy", "groupBy", "keyBy", "set", "plus", "minus", "ifParent", "onDuplicateSet", "onDuplicatePlus", "onDuplicateMinus"} {
				v.other[p+f] = true
			}
			v.other["onDuplicateSet"+f+"Expr"] = true
			v.other["select"+f+"As"] = true
			v.other["orderBy"+f+"Asc"] = true
			v.other["orderBy"+f+"Desc"] = true
			v.other["ifParent"+f+"Eq"] = true
			v.other["set"+f+"Expr"] = true
			v.terminals["sum"+f] = true
			v.terminals["avg"+f] = true
			v.terminals["min"+f] = true
			v.terminals["max"+f] = true
			v.terminals["countDistinct"+f] = true
		}
		for rn, r := range e.Relations {
			f := pascal(rn)
			v.navs[lowerFirst(f)] = true
			v.other["join"+f] = true
			v.other["leftJoin"+f] = true
			if r.Kind == "one" {
				v.other["relation"+f] = true
			} else {
				v.other["relations"+f] = true
			}
		}
		for _, cols := range e.Fulltext {
			parts := make([]string, len(cols))
			for i, c := range cols {
				parts[i] = pascal(c)
			}
			ft := lowerFirst(strings.Join(parts, "With"))
			v.other[ft+"Match"] = true
			v.other[ft+"MatchBoolean"] = true
		}
		for ix := range e.Indexes {
			v.other["forceIndex"+pascal(ix)] = true
		}
		for pn := range e.Predicates {
			v.other[lowerFirst(pascal(pn))] = true
		}
	}
	return v
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

func snakeToCamel(s string) string {
	s = strings.TrimSuffix(s, "_") // where_, match_
	parts := strings.Split(s, "_")
	for i := 1; i < len(parts); i++ {
		parts[i] = pascal(parts[i])
	}
	return strings.Join(parts, "")
}

var (
	reCallDot  = regexp.MustCompile(`(\.|::)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(`) // go, rust
	reCallPHP  = regexp.MustCompile(`(->|::)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(`) // php: `.` is string concatenation
	reHeadPHP  = regexp.MustCompile(`\b([A-Z][A-Za-z0-9_]*)::query\s*\(`)
	reHeadRust = regexp.MustCompile(`\b([a-z][a-z0-9_]*)::query\s*\(`)
	reHeadGo   = regexp.MustCompile(`\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Z][A-Za-z0-9_]*)\s*\(\s*\)`)
	reGoColRef = regexp.MustCompile(`\b[A-Z][A-Za-z0-9_]*Cols\.([A-Z][A-Za-z0-9_]*)\b`)
	reComment  = regexp.MustCompile(`(?m)//[^\n]*$|/\*[\s\S]*?\*/|(?m)^\s*#[^\n]*$`)
)

type tok struct {
	pos  int
	text string
}

// tokenize returns the canonical token stream of one source file.
func tokenize(v *vocabulary, path string, src string) []string {
	src = reComment.ReplaceAllString(src, "")
	lang := strings.TrimPrefix(filepath.Ext(path), ".")
	iterationCalls := map[int]bool{}
	if lang == "go" {
		fs := token.NewFileSet()
		f, _ := parser.ParseFile(fs, path, src, 0)
		if f != nil {
			ast.Inspect(f, func(n ast.Node) bool {
				r, ok := n.(*ast.RangeStmt)
				if !ok {
					return true
				}
				c, ok := r.X.(*ast.CallExpr)
				if !ok || len(c.Args) != 0 {
					return true
				}
				s, ok := c.Fun.(*ast.SelectorExpr)
				if ok && s.Sel.Name == "All" {
					iterationCalls[fs.Position(s.Sel.Pos()).Offset] = true
				}
				return true
			})
		}
	}
	var toks []tok
	var reHead, reCall *regexp.Regexp
	switch lang {
	case "php":
		reHead, reCall = reHeadPHP, reCallPHP
	case "rs":
		reHead, reCall = reHeadRust, reCallDot
	case "go":
		reHead, reCall = reHeadGo, reCallDot
	case "js", "mjs", "ts":
		reHead, reCall = reHeadGo, reCallDot
	default:
		fmt.Fprintf(os.Stderr, "ormgen tokens: %s: unknown language\n", path)
		os.Exit(2)
	}
	for _, m := range reHead.FindAllStringSubmatchIndex(src, -1) {
		name := src[m[2]:m[3]]
		if lang == "rs" {
			name = pascal(name)
		}
		if v.heads[name] {
			toks = append(toks, tok{m[0], "query " + name})
		}
	}
	if lang == "go" {
		for _, m := range reGoColRef.FindAllStringSubmatchIndex(src, -1) {
			name := src[m[2]:m[3]]
			toks = append(toks, tok{m[0], lowerFirst(name)})
		}
	}
	for _, m := range reCall.FindAllStringSubmatchIndex(src, -1) {
		// Collection.All used by Go's range is iteration, not a query terminal.
		if iterationCalls[m[4]] {
			continue
		}
		name := src[m[4]:m[5]]
		var canon string
		switch lang {
		case "go":
			canon = lowerFirst(name)
			if strings.ToUpper(name) == name { // Go initialisms: SQL → sql
				canon = strings.ToLower(name)
			}
		case "rs":
			canon = snakeToCamel(name)
		default:
			canon = name
		}
		if lang == "rs" && name == "new" { // heads are captured by reHeadRust
			continue
		}
		zeroArgs := zeroArgsAt(src, m[1])
		switch {
		case v.terminals[canon], v.navs[canon] && !zeroArgs, v.other[canon]:
			toks = append(toks, tok{m[0], canon})
		}
	}
	// position order (heads and calls were collected separately)
	for i := 1; i < len(toks); i++ {
		for j := i; j > 0 && toks[j-1].pos > toks[j].pos; j-- {
			toks[j-1], toks[j] = toks[j], toks[j-1]
		}
	}
	out := make([]string, len(toks))
	for i, t := range toks {
		out[i] = t.text
	}
	return out
}

func zeroArgsAt(src string, afterParen int) bool {
	for i := afterParen; i < len(src); i++ {
		switch src[i] {
		case ' ', '\t', '\n', '\r':
			continue
		case ')':
			return true
		default:
			return false
		}
	}
	return true
}

func tokens(args []string) {
	fs := flag.NewFlagSet("tokens", flag.ExitOnError)
	schemaPath := fs.String("schema", "", "schema.json (required)")
	print := fs.Bool("print", false, "print every token stream")
	// flags may precede or follow the files: `-schema x`, `--schema=x`, `--print`
	var flags, files []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-print" || a == "--print":
			flags = append(flags, a)
		case strings.HasPrefix(a, "-") && strings.Contains(a, "="):
			flags = append(flags, a)
		case strings.HasPrefix(a, "-") && i+1 < len(args):
			flags = append(flags, a, args[i+1])
			i++
		default:
			files = append(files, a)
		}
	}
	fs.Parse(flags)
	if *schemaPath == "" || len(files) < 2 {
		fmt.Fprintln(os.Stderr, "usage: ormgen tokens --schema schema/schema.json [--print] <file.go> <file.php> <file.rs> <file.ts|mjs>…")
		os.Exit(2)
	}
	js, err := os.ReadFile(*schemaPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
		os.Exit(1)
	}
	m, err := schema.Load(js)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
		os.Exit(1)
	}
	v := buildVocabulary(m)
	streams := make([][]string, len(files))
	for i, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
			os.Exit(1)
		}
		streams[i] = tokenize(v, f, string(b))
		fmt.Printf("%-45s %4d tokens\n", f, len(streams[i]))
		if *print {
			fmt.Println("  " + strings.Join(streams[i], " "))
		}
	}
	ok := true
	for i := 1; i < len(files); i++ {
		if d := firstDiff(streams[0], streams[i]); d >= 0 {
			ok = false
			fmt.Printf("DIFF at token %d: %s vs %s\n  %s: %s\n  %s: %s\n", d, files[0], files[i], files[0], window(streams[0], d), files[i], window(streams[i], d))
		}
	}
	if !ok {
		os.Exit(1)
	}
	fmt.Println("identical")
}

func firstDiff(a, b []string) int {
	for i := 0; i < len(a) || i < len(b); i++ {
		if i >= len(a) || i >= len(b) || a[i] != b[i] {
			return i
		}
	}
	return -1
}

func window(s []string, at int) string {
	lo, hi := at-3, at+4
	if lo < 0 {
		lo = 0
	}
	if hi > len(s) {
		hi = len(s)
	}
	parts := make([]string, 0, hi-lo)
	for i := lo; i < hi; i++ {
		if i == at {
			parts = append(parts, "["+s[i]+"]")
		} else {
			parts = append(parts, s[i])
		}
	}
	if at >= len(s) {
		parts = append(parts, "[<end>]")
	}
	return strings.Join(parts, " ")
}
