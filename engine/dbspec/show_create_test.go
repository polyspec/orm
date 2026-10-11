package dbspec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// showCreateVectors는 tests/dbspec/show-create.json이다: SHOW CREATE TABLE 문장과 그 안의 CHECK 이름,
// 기대하는 CHECK_CLAUSE 형식의 본문(없으면 "not found")의 집합이다.
type showCreateVectors struct {
	Catalog showCreateCatalog `json:"catalog"`
	Cases   []showCreateCase  `json:"cases"`
}

// showCreateCatalog는 introspection이 읽는 canned catalog다(tests/dbspec/show-create.json의 catalog).
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

// TestMySQLShownCheckVectors는 mysqlShownCheck가 tests/dbspec/show-create.json의 모든 case를
// 기대한 CHECK_CLAUSE 형식의 본문으로 읽는지 확인한다(T62-4-8).
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
