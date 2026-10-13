// Package contracts loads the common interface manifest, validates its native
// adapters, and generates the component documents from it.
package contracts

import (
	"bytes"
	"crypto/sha256"
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
	// Internal and InternalKO state why each client implements the component's methods privately, with no common
	// signature and so no interface rule; both are empty for a public component.
	Internal   string `json:"internal"`
	InternalKO string `json:"internal_ko"`
}
type document struct {
	Version    int                  `json:"version"`
	Rules      []rule               `json:"rules"`
	Components []component          `json:"components"`
	Edges      []edge               `json:"edges"`
	Records    []json.RawMessage    `json:"records"`
	Extensions map[string]extension `json:"extensions"`
}

// extension은 네 client 언어 밖에서 contract의 일부를 구현하는 것이다(PHP 확장 orm_dbspec). syntax는 그 선언을 읽는
// 언어의 문법이고, rules와 owners는 그것이 구현하는 rule과 owner다. 그 rule의 native adapter는 extension 이름을 key로
// 가진다.
type extension struct {
	Description string   `json:"description"`
	Syntax      string   `json:"syntax"`
	Roots       []string `json:"roots"`
	Symbols     string   `json:"symbols"`
	SymbolHash  string   `json:"symbol_hash"`
	Rules       []string `json:"rules"`
	Owners      []string `json:"owners"`
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

// documentID is the doc-id of the component document pair (scripts/kit/check-documents.mjs); the Korean document also holds the
// sha256 of the English one.
const documentID = "interfaces-model"

func diagram(korean bool) ([]byte, error) {
	d, err := load()
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	if korean {
		english, err := diagram(false)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(&b, "<!-- doc-id: %s -->\n<!-- source-sha256: %x -->\n", documentID, sha256.Sum256(english))
		b.WriteString("# 공통 구성요소\n\n<!-- contracts/interfaces.json에서 생성됨. 직접 수정하지 않는다. -->\n\n```mermaid\nclassDiagram\n")
	} else {
		fmt.Fprintf(&b, "<!-- doc-id: %s -->\n", documentID)
		b.WriteString("# Common components\n\n<!-- Generated from contracts/interfaces.json; DO NOT EDIT. -->\n\n```mermaid\nclassDiagram\n")
	}
	for _, c := range d.Components {
		fmt.Fprintf(&b, "    class %s {\n", c.ID)
		if c.Internal != "" {
			b.WriteString("        <<internal>>\n")
		}
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
		if (c.Internal == "") != (c.InternalKO == "") {
			return nil, fmt.Errorf("component %s is internal without its localized grounding", c.ID)
		}
		switch {
		case korean && c.InternalKO != "":
			description += " 내부: " + c.InternalKO
		case c.Internal != "":
			description += " Internal: " + c.Internal
		}
		fmt.Fprintf(&b, "| %s | %s |\n", c.ID, description)
	}
	if korean {
		b.WriteString("\n`<<internal>>`로 표시한 구성요소는 manifest의 `internal` 필드(`internal_ko`)가 그 근거를 적는다. 각 client가 그 method를 공통 signature 없이 비공개로 구현하므로 그 method에는 interface rule이 없다. 다른 구성요소의 모든 method는 rule을 가지며 모든 rule은 공개 구성요소의 method 하나의 rule이다. `make interface-check`가 두 방향을 모두 확인한다.\n")
	} else {
		b.WriteString("\nA component marked `<<internal>>` states its grounding in the manifest field `internal` (`internal_ko`): each client implements its methods privately with no common signature, so they have no interface rule. Every method of the other components has a rule, and every rule names a method of a public component; `make interface-check` checks both directions.\n")
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
