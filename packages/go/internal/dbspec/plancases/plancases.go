// Package plancases reads the cases of tests/dbspec/plans.json, the plan vectors that the dbspec apply tool and the
// physical dialect tests share.
package plancases

import (
	"encoding/json"
	"os"
)

// Case is one case of plans.json: its id, the document lines of its source and the lines of its plan.
type Case struct {
	ID     string   `json:"id"`
	Source []string `json:"source"`
	Plan   []string `json:"plan"`
}

// Parse reads the cases of the plans.json text raw.
func Parse(raw []byte) ([]Case, error) {
	var vectors struct {
		Cases []Case `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		return nil, err
	}
	return vectors.Cases, nil
}

// Read reads the cases of the plans.json file at path.
func Read(path string) ([]Case, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(raw)
}
