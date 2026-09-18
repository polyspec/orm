// Package contracts loads the common interface manifest, validates its native
// adapters, and generates the component documents from it.
package contracts

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
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
	ID          string            `json:"id"`
	Fields      map[string]string `json:"fields"`
	Methods     []string          `json:"methods"`
	Ownership   string            `json:"ownership"`
	OwnershipKO string            `json:"ownership_ko"`
}
type document struct {
	Version    int               `json:"version"`
	Rules      []rule            `json:"rules"`
	Components []component       `json:"components"`
	Edges      []edge            `json:"edges"`
	Records    []json.RawMessage `json:"records"`
}
type edge struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Kind   string `json:"kind"`
	Role   string `json:"role"`
	RoleKO string `json:"role_ko"`
}

func load() (document, error) {
	var d document
	if err := json.Unmarshal(source, &d); err != nil {
		return d, err
	}
	return d, validateRules(d)
}

// Diagram is derived from the same component fields, methods and ownership rules
// that reviewers change in the manifest. Handwritten lifecycle diagrams are separate.
func Diagram() ([]byte, error) {
	return diagram(false)
}

// DiagramKO generates the Korean component document from the same manifest.
func DiagramKO() ([]byte, error) {
	return diagram(true)
}

func diagram(korean bool) ([]byte, error) {
	d, err := load()
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	if korean {
		b.WriteString("# 공통 구성요소\n\n<!-- contracts/interfaces.json에서 생성됨. 직접 수정하지 않는다. -->\n\n```mermaid\nclassDiagram\n")
	} else {
		b.WriteString("# Common components\n\n<!-- Generated from contracts/interfaces.json; DO NOT EDIT. -->\n\n```mermaid\nclassDiagram\n")
	}
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
		if e.Role == "" || e.RoleKO == "" {
			return nil, fmt.Errorf("edge %s -> %s has no localized role", e.From, e.To)
		}
		fmt.Fprintf(&b, "    %s %s %s : %s\n", e.From, e.Kind, e.To, e.Role)
	}
	if korean {
		b.WriteString("```\n\n| 구성요소 | 동작 및 상태 |\n|---|---|\n")
	} else {
		b.WriteString("```\n\n| Component | Behavior and state |\n|---|---|\n")
	}
	for _, c := range d.Components {
		description := c.Ownership
		if korean {
			description = c.OwnershipKO
		}
		if description == "" {
			return nil, fmt.Errorf("component %s has no localized description", c.ID)
		}
		fmt.Fprintf(&b, "| %s | %s |\n", c.ID, description)
	}
	if korean {
		b.WriteString("\n| 시작 | 대상 | 관계 |\n|---|---|---|\n")
	} else {
		b.WriteString("\n| From | To | Relation |\n|---|---|---|\n")
	}
	for _, e := range d.Edges {
		role := e.Role
		if korean {
			role = e.RoleKO
		}
		fmt.Fprintf(&b, "| %s | %s | %s |\n", e.From, e.To, role)
	}
	if korean {
		b.WriteString("\n도표의 type 이름에서 `_`는 중첩 type 구분자다. 정확한 type은 다음 표에 정의한다.\n\n| 필드 | 공통 type |\n|---|---|\n")
	} else {
		b.WriteString("\nAn underscore in a diagram type name separates nested types. The table defines the exact types.\n\n| Field | Common type |\n|---|---|\n")
	}
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
