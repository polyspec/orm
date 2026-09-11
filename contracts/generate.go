// Package contracts generates native interface declarations from the common
// interface manifest. The implementation generators do not define these types.
package contracts

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/schema"
)

//go:embed interfaces.json
var source []byte

type native struct {
	Symbol    string `json:"symbol"`
	Signature string `json:"signature"`
}
type rule struct {
	ID     string            `json:"id"`
	For    string            `json:"for"`
	Inputs []string          `json:"inputs"`
	Output string            `json:"output"`
	Errors []string          `json:"errors"`
	Native map[string]native `json:"native"`
}
type component struct {
	ID        string            `json:"id"`
	Fields    map[string]string `json:"fields"`
	Methods   []string          `json:"methods"`
	Ownership string            `json:"ownership"`
}
type document struct {
	Version    int               `json:"version"`
	Rules      []rule            `json:"rules"`
	Components []component       `json:"components"`
	Edges      []edge            `json:"edges"`
	Records    []json.RawMessage `json:"records"`
}
type edge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
	Role string `json:"role"`
}

func load() (document, error) {
	var d document
	if err := json.Unmarshal(source, &d); err != nil {
		return d, err
	}
	return d, validateRules(d)
}
func pascal(s string) string {
	var b strings.Builder
	for _, p := range strings.Split(s, "_") {
		if p != "" {
			b.WriteString(strings.ToUpper(p[:1]) + p[1:])
		}
	}
	return b.String()
}
func colType(c *schema.Col, lang string) string {
	if lang == "go" {
		switch c.Type {
		case "i32":
			return "int32"
		case "i64":
			return "int64"
		case "f64", "decimal":
			return "float64"
		case "bool":
			return "bool"
		case "date", "datetime":
			return "time.Time"
		default:
			return "string"
		}
	}
	if lang == "php" {
		switch c.Type {
		case "i32", "i64":
			return "int"
		case "f64", "decimal":
			return "float"
		case "bool":
			return "bool"
		default:
			return "string"
		}
	}
	switch c.Type {
	case "i32":
		return "i32"
	case "i64":
		return "i64"
	case "f64", "decimal":
		return "f64"
	case "bool":
		return "bool"
	case "date":
		return "chrono::NaiveDate"
	case "datetime":
		return "chrono::NaiveDateTime"
	default:
		return "impl Into<String>"
	}
}

func signatures(d document, e *schema.Entity, lang, role string) ([]native, error) {
	var out []native
	for _, r := range d.Rules {
		if !strings.HasPrefix(r.ID, role+".") {
			continue
		}
		n, ok := r.Native[lang]
		if !ok {
			return nil, fmt.Errorf("%s: missing %s mapping", r.ID, lang)
		}
		base := map[string]string{"entity": e.Name, "Entity": pascal(e.Name)}
		var expansions []map[string]string
		switch r.For {
		case "versioned_entity":
			if e.Timestamps != nil && e.Timestamps.Updated != "" {
				expansions = append(expansions, base)
			}
		case "entity":
			expansions = append(expansions, base)
		case "eq_column":
			for _, c := range e.Columns {
				if ir.OpAllowed(c, "eq") {
					p := pascal(c.Name)
					expansions = append(expansions, map[string]string{"entity": e.Name, "Entity": pascal(e.Name), "column": c.Name, "Column": p, "columnCamel": strings.ToLower(p[:1]) + p[1:], "type": colType(c, lang)})
				}
			}
		default:
			return nil, fmt.Errorf("%s: unsupported expansion %s", r.ID, r.For)
		}
		for _, vars := range expansions {
			x := n
			for k, v := range vars {
				x.Symbol = strings.ReplaceAll(x.Symbol, "{"+k+"}", v)
				x.Signature = strings.ReplaceAll(x.Signature, "{"+k+"}", v)
			}
			out = append(out, x)
		}
	}
	return out, nil
}

// GenerateInterfaces emits compiler-enforced query interfaces. Native function
// spelling is read from the manifest; entity/column expansions use SchemaManifest.
func GenerateInterfaces(m *schema.Manifest, lang, outDir, namespace string) error {
	d, err := load()
	if err != nil {
		return err
	}
	var b bytes.Buffer
	switch lang {
	case "go":
		b.WriteString("// Code generated from contracts/interfaces.json; DO NOT EDIT.\npackage gen\nimport (\"context\"; \"time\"; \"github.com/polyspec/orm/clients/go/orm\")\nvar _ context.Context\nvar _ time.Time\n")
	case "php":
		fmt.Fprintf(&b, "<?php\n// Code generated from contracts/interfaces.json; DO NOT EDIT.\ndeclare(strict_types=1);\nnamespace %s;\n", namespace)
		records, err := json.Marshal(d.Records)
		if err != nil {
			return err
		}
		quoted := strings.NewReplacer("\\", "\\\\", "'", "\\'").Replace(string(records))
		fmt.Fprintf(&b, "\\Orm\\Wire::register(json_decode('%s', true, 512, JSON_THROW_ON_ERROR));\n", quoted)
	case "rust":
		b.WriteString("// Code generated from contracts/interfaces.json; DO NOT EDIT.\n#![allow(unused_imports, unused_mut, async_fn_in_trait)]\nuse super::*;\nuse orm::{Collection, Page, Result};\nuse orm::db::{self, Exec};\n")
	default:
		return fmt.Errorf("unsupported language %q", lang)
	}
	for _, entity := range m.Order {
		e := m.Entities[entity]
		for _, role := range []string{"Query", "Row"} {
			name := pascal(entity)
			if role == "Row" {
				name += "Row"
			}
			sigs, err := signatures(d, e, lang, role)
			if err != nil {
				return err
			}
			switch lang {
			case "go":
				fmt.Fprintf(&b, "\ntype %sInterface interface {\n", name)
				for _, n := range sigs {
					if !strings.Contains(n.Signature, "receiver=") {
						continue
					}
					method := n.Symbol[strings.LastIndex(n.Symbol, ".")+1:]
					sig := n.Signature[strings.Index(n.Signature, "func")+4:]
					fmt.Fprintf(&b, "%s%s\n", method, sig)
				}
				target := name
				if role == "Query" {
					target += "Query"
				}
				fmt.Fprintf(&b, "}\nvar _ %sInterface = (*%s)(nil)\n", name, target)
			case "php":
				fmt.Fprintf(&b, "\ninterface %sInterface {\n", name)
				for _, n := range sigs {
					sig := n.Signature
					sig = strings.ReplaceAll(sig, "App\\Orm\\", namespace+"\\")
					sig = qualifyPHP(sig, namespace)
					if strings.HasSuffix(sig, ": ") {
						sig = strings.TrimSuffix(sig, ": ")
					}
					fmt.Fprintf(&b, "%s;\n", sig)
				}
				b.WriteString("}\n")
			case "rust":
				fmt.Fprintf(&b, "\npub trait %sInterface: Sized {\n", name)
				for _, n := range sigs {
					sig := strings.TrimPrefix(n.Signature, "pub ")
					sig = strings.Replace(sig, "(mut self", "(self", 1)
					fmt.Fprintf(&b, "%s;\n", sig)
				}
				fmt.Fprintf(&b, "}\nimpl %sInterface for %s {\n", name, name)
				for _, n := range sigs {
					sig := strings.TrimPrefix(n.Signature, "pub ")
					start := strings.Index(sig, "fn ") + 3
					end := strings.Index(sig[start:], "(") + start
					method := sig[start:end]
					argsEnd := strings.Index(sig[end:], ")") + end
					params := strings.Split(sig[end+1:argsEnd], ",")
					var args []string
					for _, p := range params {
						p = strings.TrimSpace(p)
						if p == "" {
							continue
						}
						if strings.Contains(p, "self") {
							args = append(args, "self")
						} else {
							args = append(args, strings.TrimSpace(strings.SplitN(p, ":", 2)[0]))
						}
					}
					await := ""
					if strings.HasPrefix(sig, "async ") {
						await = ".await"
					}
					fmt.Fprintf(&b, "%s { %s::%s(%s)%s }\n", sig, name, method, strings.Join(args, ","), await)
				}
				b.WriteString("}\n")
			}
		}
	}
	path := filepath.Join(outDir, "Interfaces.php")
	body := b.Bytes()
	if lang == "go" {
		path = filepath.Join(outDir, "interfaces.go")
		body, err = format.Source(body)
		if err != nil {
			return fmt.Errorf("generated interfaces: %w", err)
		}
	}
	if lang == "rust" {
		path = filepath.Join(outDir, "src/interfaces.rs")
	}
	return os.WriteFile(path, body, 0644)
}

func qualifyPHP(sig, namespace string) string {
	re := regexp.MustCompile(`\b(?:` + regexp.QuoteMeta(namespace) + `\\\w+|Orm\\\w+|PDO)\b`)
	return re.ReplaceAllStringFunc(sig, func(s string) string { return "\\" + s })
}

// Diagram is derived from the same component fields, methods and ownership rules
// that reviewers change in the manifest. Handwritten lifecycle diagrams are separate.
func Diagram() ([]byte, error) {
	d, err := load()
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	b.WriteString("# 공통 구성요소\n\n<!-- Generated from contracts/interfaces.json; DO NOT EDIT. -->\n\n```mermaid\nclassDiagram\n")
	for _, c := range d.Components {
		fmt.Fprintf(&b, "    class %s {\n", c.ID)
		keys := make([]string, 0, len(c.Fields))
		for k := range c.Fields {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			t := strings.Trim(regexp.MustCompile(`[^A-Za-z0-9]+`).ReplaceAllString(c.Fields[k], "_"), "_")
			fmt.Fprintf(&b, "        %s %s\n", t, k)
		}
		for _, m := range c.Methods {
			fmt.Fprintf(&b, "        %s()\n", m)
		}
		b.WriteString("    }\n")
	}
	for _, e := range d.Edges {
		fmt.Fprintf(&b, "    %s %s %s : %s\n", e.From, e.Kind, e.To, e.Role)
	}
	b.WriteString("```\n\n| 구성요소 | 책임·소유 규칙 |\n|---|---|\n")
	for _, c := range d.Components {
		fmt.Fprintf(&b, "| %s | %s |\n", c.ID, c.Ownership)
	}
	b.WriteString("\n도표의 타입 이름에서 `_`는 중첩 타입 구분자다. 정확한 타입은 다음과 같다.\n\n| 필드 | 공통 타입 |\n|---|---|\n")
	for _, c := range d.Components {
		keys := make([]string, 0, len(c.Fields))
		for k := range c.Fields {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(&b, "| %s.%s | `%s` |\n", c.ID, k, c.Fields[k])
		}
	}
	return b.Bytes(), nil
}
