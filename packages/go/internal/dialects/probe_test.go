package dialects

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestProbeIDs verifies that probe IDs are unique, well formed and name the
// database each probe runs on.
func TestProbeIDs(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	begin := time.Now()
	probes := All()
	if err := Validate(probes); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]Probe{
		{{ID: "mysql.a.b", DB: "mysql", Fact: "f", Run: func(*Env) {}}, {ID: "mysql.a.b", DB: "mysql", Fact: "f", Run: func(*Env) {}}},
		{{ID: "mysql.a.b", DB: "sqlite", Fact: "f", Run: func(*Env) {}}},
		{{ID: "mysql.A.b", DB: "mysql", Fact: "f", Run: func(*Env) {}}},
		{{ID: "mysql.a.b", DB: "mysql", Run: func(*Env) {}}},
	} {
		if err := Validate(bad); err == nil {
			t.Errorf("Validate accepted %+v", bad[len(bad)-1].ID)
		}
	}
	t.Logf("%d probe IDs valid in %s", len(probes), time.Since(begin).Round(time.Microsecond))
}

// citedProbe is a probe ID written as inline code in a dialects page.
var citedProbe = regexp.MustCompile("`((?:mysql|postgres|sqlite)\\.[a-z0-9_]+\\.[a-z0-9_]+)`")

// TestProbeCitations verifies that docs/dialects.md and its Korean twin cite
// every fact probe and cite no probe ID that neither a fact probe nor a DDL
// vector of tests/dbspec/ddl.json runs, so a probed fact has its rule and a
// rule cites only probes that run.
func TestProbeCitations(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	known := map[string]bool{}
	probes := All()
	for _, p := range probes {
		known[p.ID] = true
	}
	raw, err := os.ReadFile(filepath.Join(repoRoot, "tests", "dbspec", "ddl.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			ID string `json:"id"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, c := range vectors.Cases {
		for _, db := range []string{"mysql", "postgres", "sqlite"} {
			known[db+".ddl."+strings.ReplaceAll(c.ID, "-", "_")] = true
		}
	}
	for _, page := range []string{"dialects.md", "dialects.ko.md"} {
		text, err := os.ReadFile(filepath.Join(repoRoot, "docs", page))
		if err != nil {
			t.Fatal(err)
		}
		cited := map[string]bool{}
		for _, match := range citedProbe.FindAllStringSubmatch(string(text), -1) {
			cited[match[1]] = true
			if !known[match[1]] {
				t.Errorf("docs/%s cites %s, which no probe runs", page, match[1])
			}
		}
		for _, p := range probes {
			if !cited[p.ID] {
				t.Errorf("docs/%s does not cite the probe %s (%s)", page, p.ID, p.Fact)
			}
		}
	}
}

// TestRestrictRowOrder verifies that docs/dialects.md and its Korean twin
// state the RESTRICT timing of one multi-row delete: MySQL and SQLite refuse
// it when the referenced row comes first, PostgreSQL accepts it, and portable
// code deletes the referencing rows first.
func TestRestrictRowOrder(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	rules := map[string]string{
		"dialects.md":    "One `DELETE` that removes a referenced row and a row referencing it is refused by MySQL and SQLite when the referenced row comes first in their row order and accepted by PostgreSQL; portable code deletes the referencing rows first.",
		"dialects.ko.md": "하나의 `DELETE`가 참조되는 행과 그 행을 참조하는 행을 함께 지우면, MySQL과 SQLite는 참조되는 행이 행 순서에서 먼저 나올 때 거부하고 PostgreSQL은 받아들인다; 이식 가능한 코드는 참조하는 행을 먼저 지운다.",
	}
	for page, rule := range rules {
		text, err := os.ReadFile(filepath.Join(repoRoot, "docs", page))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(text), rule) {
			t.Errorf("docs/%s does not state the RESTRICT row order rule: %s", page, rule)
		}
	}
}
