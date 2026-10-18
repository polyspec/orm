package ir

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestValidateVectors reads the shared validation cases (tests/ir/validate.json). It adds each request's schema
// manifest_hash, passes the request to Decode (that is, Validate), and checks that it is accepted or fails with the expected error code.
// TypeScript, PHP, Rust, and Python read the same file in their own packages.
func TestValidateVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	root := filepath.Join("..", "..", "..", "..")
	src, err := os.ReadFile(filepath.Join(root, "tests", "ir", "validate.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Schema string `json:"schema"`
		Cases  []struct {
			Name string `json:"name"`
			// Each member stays as its JSON text, so a number keeps its literal (0.0 is not 0).
			Request map[string]json.RawMessage `json:"request"`
			Valid   bool                       `json:"valid"`
			Error   string                     `json:"error"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(src, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("validate.json has no cases")
	}
	m, err := runtimemodel.LoadFiles(filepath.Join(root, file.Schema))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if c.Valid == (c.Error != "") {
				t.Fatal("a case expects either valid or an error")
			}
			if _, ok := c.Request["manifest_hash"]; ok {
				t.Fatal("request already holds manifest_hash")
			}
			hash, err := json.Marshal(m.ManifestHash)
			if err != nil {
				t.Fatal(err)
			}
			c.Request["manifest_hash"] = hash
			body, err := json.Marshal(c.Request)
			if err != nil {
				t.Fatal(err)
			}
			_, err = Decode(m, body)
			switch {
			case c.Valid && err != nil:
				t.Error(err)
			case c.Error != "" && (err == nil || !strings.HasPrefix(err.Error(), c.Error+":")):
				t.Errorf("got %v, want %s", err, c.Error)
			}
		})
	}
}
