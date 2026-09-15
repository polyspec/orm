// Package schema turns the hand-written Mermaid erDiagram (docs/schema.md)
// into the manifest the engine and generators consume.
//
// Only three things are added on top of standard Mermaid:
//   - column comment strings carry attributes:  "? =0 auto onupdate bool lazy aes hex -> user.seq"
//   - %% directives:  %% unique|index|fulltext <table> (<cols>) [name], or
//     %% blind_index <table> <encrypted_column> <index_column>
//   - relationship labels name one FK column or an ordered list: "fk_col (child_name / parent_name)" or "(fk_a, fk_b) (child_name / parent_name)"
package schema

import (
	"bufio"
	"fmt"
	"regexp"
	"strings"
)

// The core checks extension syntax and preserves values. Semantic meaning is
// validated by the consuming generator.
var ormDirectiveOptions = map[string]map[string]bool{
	"table":        {"entity": true, "name": true},
	"foreign":      {"entity": true, "columns": true, "references": true, "name": true, "on_delete": true, "deferred": true},
	"immutable":    {"entity": true},
	"field":        {"relation": true, "fk": true, "public": true, "required": true, "order": true},
	"public-key":   {"entity": true, "field": true, "type": true, "unique": true, "stable": true},
	"resource-key": {"route": true, "param": true, "field": true},
	"route":        {}, "path": {},
	"scope":      {"route": true, "param": true, "field": true},
	"filter":     {"route": true, "param": true, "field": true},
	"operation":  {"route": true, "method": true},
	"permission": {"route": true, "action": true, "owner": true},
}

// Diagram is the parsed .mmd file, before validation and name derivation.
type Diagram struct {
	Entities   []*DEntity
	Relations  []*DRelation
	Directives []*Directive
	ORM        []*ORMDirective
}

// ORMDirective is a namespaced extension preserved in schema.json for higher-level
// generators. The core ORM does not infer CRUD or authorization meaning from it.
type ORMDirective struct {
	Kind string            `json:"kind"`
	Name string            `json:"name,omitempty"`
	Args map[string]string `json:"args,omitempty"`
	Raw  string            `json:"raw"`
	Line int               `json:"-"`
}

type DEntity struct {
	Name    string
	Comment string // database table comment from %% table_comment
	Columns []*DColumn
	Line    int
}

type DColumn struct {
	Type      string // raw type text, e.g. varchar(191), decimal(13_3)
	Name      string
	Keys      []string // PK, FK, UK
	Comment   string   // raw comment string without quotes
	DBComment string   // database column comment from %% column_comment
	Line      int

	// Parsed from Comment.
	Nullable bool
	Default  *string // nil = none; "now" and "null" are keywords
	Auto     bool
	OnUpdate bool
	Unsigned bool
	Bool     bool
	Int      bool // force integer exposure for is_* tinyint
	Lazy     bool
	Styles   []string
	Ref      string // "table.column" from "-> table.column"
	Describe string // leftover words
}

type DRelation struct {
	Parent      string
	Child       string
	Cardinality string // the raw "||--o{" token
	Label       string
	Line        int

	// Parsed from Label.
	FKs        []string
	ChildName  string // override for child->parent relation name
	ParentName string // override for parent->child relation name
	OnDelete   string // "", cascade, setnull
}

type Directive struct {
	Kind    string // unique, index, fulltext, check, blind_index, timestamps, predicate, many_to_many
	Table   string
	Columns []string
	Name    string
	Through string
	Raw     string
	Line    int
}

type ParseError struct {
	Line int
	Msg  string
}

func (e *ParseError) Error() string { return fmt.Sprintf("line %d: %s", e.Line, e.Msg) }

var (
	reEntityOpen = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*$`)
	// type name [keys] ["comment"]
	reColumn = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_()\[\]]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?\s*(?:"([^"]*)")?\s*$`)
	// parent CARD child : label
	reRelation = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*)\s+([|}o]{1,2}[-.]{2}[|{o]{1,2})\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$`)
	// %% kind table (a, b) [name]
	reDirective      = regexp.MustCompile(`^%%\s*(unique|index|fulltext|check|blind_index|timestamps|scope|aes_version|soft_delete|predicate|many_to_many|table_comment|column_comment|rename_table|rename_column)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$`)
	reRelationNames  = regexp.MustCompile(`^(?:\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*/\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\))?\s*(.*)$`)
	reRef            = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$`)
	reDirectiveIdent = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
	reORMName        = regexp.MustCompile(`^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)?$`)
)

var styleWords = map[string]bool{"aes": true, "hex": true, "gz": true, "json": true, "jsons": true, "base64": true, "serialize": true, "ip": true, "yaml": true, "curlfile": true}

// Parse reads one .mmd file. It accepts exactly the subset in docs/schema.md
// and fails loudly on anything else — a schema file is not a place for guesses.
func Parse(src string) (*Diagram, error) {
	d := &Diagram{}
	sc := bufio.NewScanner(strings.NewReader(src))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	var cur *DEntity
	lastORMRoute := ""
	seenORM := map[string]bool{}
	line := 0
	seenHeader := false
	for sc.Scan() {
		line++
		raw := sc.Text()
		t := strings.TrimSpace(raw)
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "%%") {
			if strings.HasPrefix(t, "%% orm:") {
				x, err := parseORMDirective(t, line)
				if err != nil {
					return nil, err
				}
				if x.Kind == "route" {
					lastORMRoute = x.Name
				} else if x.Kind == "path" {
					if lastORMRoute == "" {
						return nil, &ParseError{line, "%% orm:path requires a preceding route"}
					}
					x.Args["route"] = lastORMRoute
				}
				identity := ormDirectiveIdentity(x)
				if seenORM[identity] {
					return nil, &ParseError{line, "duplicate ORM directive " + identity}
				}
				seenORM[identity] = true
				d.ORM = append(d.ORM, x)
				continue
			}
			if m := reDirective.FindStringSubmatch(t); m != nil {
				dir, err := parseDirective(m, line)
				if err != nil {
					return nil, err
				}
				d.Directives = append(d.Directives, dir)
			}
			continue // plain comments are ignored
		}
		if !seenHeader {
			if t != "erDiagram" {
				return nil, &ParseError{line, "file must start with erDiagram"}
			}
			seenHeader = true
			continue
		}
		if cur != nil {
			if t == "}" {
				cur = nil
				continue
			}
			m := reColumn.FindStringSubmatch(t)
			if m == nil {
				return nil, &ParseError{line, fmt.Sprintf("bad column line in %s: %q", cur.Name, t)}
			}
			c := &DColumn{Type: m[1], Name: m[2], Comment: m[4], Line: line}
			if m[3] != "" {
				for _, k := range strings.Split(m[3], ",") {
					c.Keys = append(c.Keys, strings.TrimSpace(k))
				}
			}
			if err := parseColumnComment(c); err != nil {
				return nil, &ParseError{line, err.Error()}
			}
			cur.Columns = append(cur.Columns, c)
			continue
		}
		if m := reEntityOpen.FindStringSubmatch(t); m != nil {
			cur = &DEntity{Name: m[1], Line: line}
			d.Entities = append(d.Entities, cur)
			continue
		}
		if m := reRelation.FindStringSubmatch(t); m != nil {
			r := &DRelation{Parent: m[1], Cardinality: m[2], Child: m[3], Label: strings.Trim(strings.TrimSpace(m[4]), `"`), Line: line}
			if err := parseLabel(r); err != nil {
				return nil, &ParseError{line, err.Error()}
			}
			d.Relations = append(d.Relations, r)
			continue
		}
		return nil, &ParseError{line, fmt.Sprintf("unrecognized line: %q", t)}
	}
	if cur != nil {
		return nil, &ParseError{line, "unterminated entity " + cur.Name}
	}
	if !seenHeader {
		return nil, &ParseError{0, "empty file"}
	}
	return d, nil
}

func ormDirectiveIdentity(x *ORMDirective) string {
	if x.Kind == "field" {
		return x.Kind + ":" + x.Name
	}
	if x.Kind == "route" {
		return x.Kind + ":" + x.Name
	}
	if x.Kind == "path" {
		return x.Kind + ":" + x.Args["route"]
	}
	if route := x.Args["route"]; route != "" {
		return x.Kind + ":" + route + ":" + x.Args["param"] + ":" + x.Args["method"] + ":" + x.Args["action"]
	}
	if x.Kind == "public-key" {
		return x.Kind + ":" + x.Args["entity"] + "." + x.Args["field"]
	}
	if x.Kind == "resource-key" {
		return x.Kind + ":" + x.Args["route"] + ":" + x.Args["param"]
	}
	return x.Kind + ":" + x.Raw
}

func parseORMDirective(line string, number int) (*ORMDirective, error) {
	body := strings.TrimSpace(strings.TrimPrefix(line, "%% orm:"))
	if body == "" {
		return nil, &ParseError{number, "%% orm:<kind> requires a directive kind"}
	}
	parts := strings.Fields(body)
	kind := parts[0]
	if !reDirectiveIdent.MatchString(kind) {
		return nil, &ParseError{number, "invalid ORM directive kind " + kind}
	}
	allowed, known := ormDirectiveOptions[kind]
	if !known {
		return nil, &ParseError{number, "unknown ORM directive " + kind}
	}
	x := &ORMDirective{Kind: kind, Raw: body, Line: number, Args: map[string]string{}}
	positional := parts[1:]
	if len(positional) > 0 && !strings.Contains(positional[0], "=") {
		if !reORMName.MatchString(positional[0]) && kind != "path" {
			return nil, &ParseError{number, "invalid ORM directive identifier " + positional[0]}
		}
		x.Name = positional[0]
		positional = positional[1:]
	}
	for _, token := range positional {
		key, value, found := strings.Cut(token, "=")
		if !found || !reDirectiveIdent.MatchString(key) || value == "" {
			return nil, &ParseError{number, fmt.Sprintf("%% orm:%s requires key=value options", kind)}
		}
		if !allowed[key] {
			return nil, &ParseError{number, fmt.Sprintf("%% orm:%s: unknown option %s", kind, key)}
		}
		if _, duplicate := x.Args[key]; duplicate {
			return nil, &ParseError{number, fmt.Sprintf("%% orm:%s: duplicate option %s", kind, key)}
		}
		x.Args[key] = value
	}
	return x, nil
}

func parseColumnComment(c *DColumn) error {
	words := strings.Fields(c.Comment)
	var desc []string
	for i := 0; i < len(words); i++ {
		w := words[i]
		switch {
		case w == "?":
			c.Nullable = true
		case strings.HasPrefix(w, "="):
			v := w[1:]
			c.Default = &v
		case w == "auto":
			c.Auto = true
		case w == "onupdate":
			c.OnUpdate = true
		case w == "unsigned":
			c.Unsigned = true
		case w == "bool":
			c.Bool = true
		case w == "int":
			c.Int = true
		case w == "lazy":
			c.Lazy = true
		case w == "->":
			if i+1 >= len(words) || !reRef.MatchString(words[i+1]) {
				return fmt.Errorf("column %s: '->' must be followed by table.column", c.Name)
			}
			c.Ref = words[i+1]
			i++
		case strings.Contains(w, ","):
			// "aes,hex" — a style pipeline written compactly
			ok := true
			for _, s := range strings.Split(w, ",") {
				if !styleWords[s] {
					ok = false
				}
			}
			if !ok {
				desc = append(desc, w)
				continue
			}
			c.Styles = append(c.Styles, strings.Split(w, ",")...)
		case styleWords[w]:
			c.Styles = append(c.Styles, w)
		default:
			desc = append(desc, w)
		}
	}
	c.Describe = strings.Join(desc, " ")
	if c.Bool && c.Int {
		return fmt.Errorf("column %s: bool and int are exclusive", c.Name)
	}
	return nil
}

func parseLabel(r *DRelation) error {
	if r.Label == "" {
		return fmt.Errorf("relation %s -> %s: label must name the FK column", r.Parent, r.Child)
	}
	rest := r.Label
	if strings.HasPrefix(rest, "(") {
		close := strings.IndexByte(rest, ')')
		if close < 0 {
			return fmt.Errorf("relation %s -> %s: bad label %q", r.Parent, r.Child, r.Label)
		}
		for _, value := range strings.Split(rest[1:close], ",") {
			value = strings.TrimSpace(value)
			if !reDirectiveIdent.MatchString(value) {
				return fmt.Errorf("relation %s -> %s: bad FK column %q", r.Parent, r.Child, value)
			}
			r.FKs = append(r.FKs, value)
		}
		rest = strings.TrimSpace(rest[close+1:])
	} else {
		fields := strings.Fields(rest)
		if len(fields) == 0 || !reDirectiveIdent.MatchString(fields[0]) {
			return fmt.Errorf("relation %s -> %s: bad label %q", r.Parent, r.Child, r.Label)
		}
		r.FKs = []string{fields[0]}
		rest = strings.TrimSpace(strings.TrimPrefix(rest, fields[0]))
	}
	m := reRelationNames.FindStringSubmatch(rest)
	if m == nil {
		return fmt.Errorf("relation %s -> %s: bad label %q", r.Parent, r.Child, r.Label)
	}
	r.ChildName, r.ParentName = m[1], m[2]
	for _, w := range strings.Fields(m[3]) {
		switch w {
		case "cascade", "setnull":
			r.OnDelete = w
		default:
			return fmt.Errorf("relation %s -> %s: unknown label word %q", r.Parent, r.Child, w)
		}
	}
	return nil
}

func parseDirective(m []string, line int) (*Directive, error) {
	d := &Directive{Kind: m[1], Table: m[2], Raw: strings.TrimSpace(m[3]), Line: line}
	switch d.Kind {
	case "unique", "index", "fulltext":
		open := strings.Index(d.Raw, "(")
		closeIdx := strings.LastIndex(d.Raw, ")")
		if open != 0 || closeIdx < 0 {
			return nil, &ParseError{line, fmt.Sprintf("%%%% %s %s: expected (col, …)", d.Kind, d.Table)}
		}
		for _, c := range strings.Split(d.Raw[1:closeIdx], ",") {
			c = strings.TrimSpace(c)
			if c == "" {
				return nil, &ParseError{line, fmt.Sprintf("%%%% %s %s: empty column", d.Kind, d.Table)}
			}
			d.Columns = append(d.Columns, c)
		}
		d.Name = strings.TrimSpace(d.Raw[closeIdx+1:])
		if d.Kind != "index" && d.Name != "" {
			return nil, &ParseError{line, fmt.Sprintf("%%%% %s: only index takes a name", d.Kind)}
		}
	case "check":
		name, body, ok := strings.Cut(d.Raw, ":")
		if !ok || !reDirectiveIdent.MatchString(strings.TrimSpace(name)) || strings.TrimSpace(body) == "" {
			return nil, &ParseError{line, "%% check <table> <name> : <expression>"}
		}
		d.Name = strings.TrimSpace(name)
		d.Raw = strings.TrimSpace(body)
	case "timestamps":
		d.Columns = strings.Fields(d.Raw)
		if len(d.Columns) != 2 {
			return nil, &ParseError{line, "%% timestamps <table> <created> <updated>"}
		}
	case "scope":
		d.Columns = strings.Fields(d.Raw)
		if len(d.Columns) != 1 {
			return nil, &ParseError{line, "%% scope <table> <column>"}
		}
	case "aes_version":
		d.Columns = strings.Fields(d.Raw)
		if len(d.Columns) != 1 || !reDirectiveIdent.MatchString(d.Columns[0]) {
			return nil, &ParseError{line, "%% aes_version <table> <version_column>"}
		}
	case "soft_delete":
		d.Columns = strings.Fields(d.Raw)
		if len(d.Columns) != 1 {
			return nil, &ParseError{line, "%% soft_delete <table> <nullable_datetime_column>"}
		}
	case "blind_index":
		d.Columns = strings.Fields(d.Raw)
		if len(d.Columns) != 2 || !reDirectiveIdent.MatchString(d.Columns[0]) || !reDirectiveIdent.MatchString(d.Columns[1]) {
			return nil, &ParseError{line, "%% blind_index <table> <encrypted_column> <index_column>"}
		}
	case "predicate":
		name, body, ok := strings.Cut(d.Raw, ":")
		if !ok || strings.TrimSpace(name) == "" || strings.TrimSpace(body) == "" {
			return nil, &ParseError{line, "%% predicate <table> <name> : <dsl>"}
		}
		d.Name = strings.TrimSpace(name)
		d.Raw = strings.TrimSpace(body)
	case "many_to_many":
		parts := strings.Fields(d.Raw)
		if len(parts) != 5 || parts[3] != "through" || !reDirectiveIdent.MatchString(parts[0]) || !reDirectiveIdent.MatchString(parts[1]) || !reDirectiveIdent.MatchString(parts[2]) || !reDirectiveIdent.MatchString(parts[4]) {
			return nil, &ParseError{line, "%% many_to_many <target_entity> <source_relation> <target_relation> through <through_entity>"}
		}
		d.Columns = []string{parts[0], parts[2]}
		d.Name = parts[1]
		d.Through = parts[4]
	case "table_comment":
		if d.Raw == "" || !strings.HasPrefix(d.Raw, `"`) || !strings.HasSuffix(d.Raw, `"`) {
			return nil, &ParseError{line, "%% table_comment <table> \"text\""}
		}
		d.Raw = strings.Trim(d.Raw, `"`)
	case "column_comment":
		parts := strings.Fields(d.Raw)
		if len(parts) < 2 || !strings.HasPrefix(strings.TrimSpace(d.Raw[len(parts[0]):]), `"`) || !strings.HasSuffix(strings.TrimSpace(d.Raw[len(parts[0]):]), `"`) {
			return nil, &ParseError{line, "%% column_comment <table> <column> \"text\""}
		}
		d.Columns = []string{parts[0]}
		text := strings.TrimSpace(d.Raw[len(parts[0]):])
		d.Raw = strings.Trim(text, `"`)
	case "rename_table":
		parts := strings.Fields(d.Raw)
		if len(parts) != 1 || !reDirectiveIdent.MatchString(parts[0]) {
			return nil, &ParseError{line, "%% rename_table <new_table> <old_table>"}
		}
		d.Name = parts[0]
	case "rename_column":
		parts := strings.Fields(d.Raw)
		if len(parts) != 2 || !reDirectiveIdent.MatchString(parts[0]) || !reDirectiveIdent.MatchString(parts[1]) {
			return nil, &ParseError{line, "%% rename_column <table> <new_column> <old_column>"}
		}
		d.Columns = []string{parts[0]}
		d.Name = parts[1]
	}
	return d, nil
}
