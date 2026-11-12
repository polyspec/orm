package testcase

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Implementations returns the names of the implementations that the
// contracts/implementations.json of the repository at root declares, in their
// order. A missing or invalid file panics, since the tests that read it cannot
// run without it.
func Implementations(root string) []string {
	raw, err := os.ReadFile(filepath.Join(root, "contracts", "implementations.json"))
	if err != nil {
		panic(err)
	}
	var declared struct {
		Implementations []struct {
			Name string `json:"name"`
		} `json:"implementations"`
	}
	if err := json.Unmarshal(raw, &declared); err != nil {
		panic(err)
	}
	names := make([]string, 0, len(declared.Implementations))
	for _, implementation := range declared.Implementations {
		names = append(names, implementation.Name)
	}
	return names
}
