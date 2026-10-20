package testcase

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ParityImplementations returns the names of the implementations that the
// config/parity.json of the repository at root declares. A missing or invalid
// file panics, since the tests that read it cannot run without it.
func ParityImplementations(root string) []string {
	raw, err := os.ReadFile(filepath.Join(root, "config", "parity.json"))
	if err != nil {
		panic(err)
	}
	var parity struct {
		Implementations []struct {
			Name string `json:"name"`
		} `json:"implementations"`
	}
	if err := json.Unmarshal(raw, &parity); err != nil {
		panic(err)
	}
	names := make([]string, 0, len(parity.Implementations))
	for _, implementation := range parity.Implementations {
		names = append(names, implementation.Name)
	}
	return names
}
