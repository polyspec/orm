package dbspec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// showCreateVectors is tests/dbspec/show-create.json: the SHOW CREATE TABLE statements, their CHECK names,
// and the set of expected bodies in CHECK_CLAUSE form ("not found" if there is none).
type showCreateVectors struct {
	Catalog showCreateCatalog `json:"catalog"`
	Cases   []showCreateCase  `json:"cases"`
}

// showCreateCatalog is the canned catalog that introspection reads (the catalog of tests/dbspec/show-create.json).
type showCreateCatalog struct {
	Table        string             `json:"table"`
	Columns      []showCreateColumn `json:"columns"`
	PrimaryKey   string             `json:"primary_key"`
	StoredClause string             `json:"stored_clause"`
}

type showCreateColumn struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	Nullable  string `json:"nullable"`
	Charset   string `json:"charset"`
	Collation string `json:"collation"`
}

type showCreateCase struct {
	ID          string   `json:"id"`
	Create      []string `json:"create"`
	Name        string   `json:"name"`
	Expected    string   `json:"expected"`
	Checks      []string `json:"checks"`
	Unsupported []string `json:"unsupported"`
	Error       string   `json:"error"`
}

// TestMySQLShownCheckVectors checks that mysqlShownCheck reads every case of tests/dbspec/show-create.json
// as the expected body in CHECK_CLAUSE form (T62-4-8).
func TestMySQLShownCheckVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	raw, err := os.ReadFile(filepath.Join(repositoryRoot(t), "tests", "dbspec", "show-create.json"))
	if err != nil {
		t.Fatalf("cannot read tests/dbspec/show-create.json: %v; run from a checkout of this repository", err)
	}
	var v showCreateVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("tests/dbspec/show-create.json is not valid JSON: %v", err)
	}
	if len(v.Cases) == 0 {
		t.Fatal("tests/dbspec/show-create.json has no cases")
	}
	for _, c := range v.Cases {
		t.Run(c.ID, func(t *testing.T) {
			got, ok := mysqlShownCheck(strings.Join(c.Create, "\n")+"\n", c.Name)
			if c.Expected == "not found" {
				if ok {
					t.Fatalf("mysqlShownCheck(%q) = %q, want not found", c.Name, got)
				}
				return
			}
			if !ok {
				t.Fatalf("mysqlShownCheck(%q) reported not found, want %q", c.Name, c.Expected)
			}
			if got != c.Expected {
				t.Fatalf("mysqlShownCheck(%q)\n got: %s\nwant: %s", c.Name, got, c.Expected)
			}
		})
	}
}
