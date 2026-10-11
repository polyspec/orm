package ir

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
)

// TestValidateVectors는 공유 검증 case(tests/ir/validate.json)를 읽는다. 각 request에 schema의
// manifest_hash를 더해 Decode(곧 Validate)에 주고, 받아들이는지나 기대한 오류 code로 실패하는지 본다.
// TypeScript, PHP, Rust, Python이 같은 파일을 자기 package에서 읽는다.
func TestValidateVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	root := filepath.Join("..", "..")
	src, err := os.ReadFile(filepath.Join(root, "tests", "ir", "validate.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Schema string `json:"schema"`
		Cases  []struct {
			Name    string         `json:"name"`
			Request map[string]any `json:"request"`
			Valid   bool           `json:"valid"`
			Error   string         `json:"error"`
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
		if c.Valid == (c.Error != "") {
			t.Fatalf("%s: a case expects either valid or an error", c.Name)
		}
		if _, ok := c.Request["manifest_hash"]; ok {
			t.Fatalf("%s: request already holds manifest_hash", c.Name)
		}
		c.Request["manifest_hash"] = m.ManifestHash
		body, err := json.Marshal(c.Request)
		if err != nil {
			t.Fatal(err)
		}
		_, err = Decode(m, body)
		switch {
		case c.Valid && err != nil:
			t.Errorf("%s: %v", c.Name, err)
		case c.Error != "" && (err == nil || !strings.HasPrefix(err.Error(), c.Error+":")):
			t.Errorf("%s: got %v, want %s", c.Name, err, c.Error)
		}
	}
}
