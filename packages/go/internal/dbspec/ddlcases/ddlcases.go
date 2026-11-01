// Package ddlcases reads the vectors of tests/dbspec/ddl.json, the rendered statements and behavior steps that the physical
// dialect tests and the client tests share.
package ddlcases

import (
	"encoding/json"
	"fmt"
	"os"
)

// Vectors is tests/dbspec/ddl.json: the rendered statements of each case and its behavior steps.
type Vectors struct {
	Version int    `json:"version"`
	Cases   []Case `json:"cases"`
}

// Case is one vector: its id, its rendered statements per dialect and its behavior steps.
type Case struct {
	ID         string              `json:"id"`
	Statements map[string][]string `json:"statements"`
	Behavior   []Step              `json:"behavior"`
}

// Step runs sql, which must succeed or, with fails, fail; or runs query, whose first value must equal want. Dialects
// limits the step to the dialects it names.
type Step struct {
	SQL      string   `json:"sql"`
	Fails    bool     `json:"fails"`
	Query    string   `json:"query"`
	Want     string   `json:"want"`
	Dialects []string `json:"dialects"`
}

// Parse decodes the text of tests/dbspec/ddl.json and checks its version and that it has cases.
func Parse(raw []byte) (Vectors, error) {
	var vectors Vectors
	if err := json.Unmarshal(raw, &vectors); err != nil {
		return Vectors{}, err
	}
	if vectors.Version != 1 || len(vectors.Cases) == 0 {
		return Vectors{}, fmt.Errorf("tests/dbspec/ddl.json has version %d and %d cases", vectors.Version, len(vectors.Cases))
	}
	return vectors, nil
}

// Read reads and parses the file at path.
func Read(path string) (Vectors, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Vectors{}, err
	}
	return Parse(raw)
}
