// Package contracts loads the common interface manifest and validates its native
// adapters. The component documents are generated from it by tests/interfaces/check.
package contracts

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// source is contracts/interfaces.json, read from the package directory where go test runs (tests/interfaces/contracts);
// the manifest is the repository's, outside the tests module, so it is read rather than embedded.
var source, sourceErr = os.ReadFile(filepath.Join("..", "..", "..", "contracts", "interfaces.json"))

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

// An extension implements part of the contract outside the four client languages (PHP extension polyspec_orm). syntax is the grammar of the language that reads its declarations, and rules and owners are the ones it implements. The native adapter of such a rule
// is keyed by the extension name
// as its key.
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
	if sourceErr != nil {
		return d, sourceErr
	}
	if err := json.Unmarshal(source, &d); err != nil {
		return d, err
	}
	return d, validateRules(d)
}
