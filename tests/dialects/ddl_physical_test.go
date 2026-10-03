//go:build physical

package dialects

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/internal/testcase"
)

// ddlVectors is tests/dbspec/ddl.json (docs/dialects.md "Rendered
// statements").
type ddlVectors struct {
	Version int `json:"version"`
	Cases   []struct {
		ID         string              `json:"id"`
		Statements map[string][]string `json:"statements"`
		Behavior   []ddlStep           `json:"behavior"`
	} `json:"cases"`
}

// ddlStep runs sql, which must succeed or, with fails, fail; or runs query,
// whose first value must equal want. dialects limits the step.
type ddlStep struct {
	SQL      string   `json:"sql"`
	Fails    bool     `json:"fails"`
	Query    string   `json:"query"`
	Want     string   `json:"want"`
	Dialects []string `json:"dialects"`
}

// connectionRules are the statements every client runs on a new connection:
// UTC on MySQL and PostgreSQL and foreign keys on SQLite (docs/dbspec.md
// "Types", docs/dialects.md "Foreign keys").
var connectionRules = map[string][]string{
	"mysql":    {"SET time_zone = '+00:00'"},
	"postgres": {"SET TimeZone = 'UTC'"},
	"sqlite":   {"PRAGMA foreign_keys = ON"},
}

// TestDDLVectors applies the statements of every vector of
// tests/dbspec/ddl.json to its own MySQL database, PostgreSQL schema and
// SQLite file of TEST_ENV, then runs the vector's behavior steps.
func TestDDLVectors(t *testing.T) {
	testcase.Group(t)
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV")
	}
	raw, err := os.ReadFile(filepath.Join("..", "dbspec", "ddl.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors ddlVectors
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if vectors.Version != 1 || len(vectors.Cases) == 0 {
		t.Fatalf("tests/dbspec/ddl.json has version %d and %d cases", vectors.Version, len(vectors.Cases))
	}
	connect, cancel := context.WithTimeout(context.Background(), probeDeadline)
	servers, err := OpenServers(connect, mysqlDSN, postgresDSN, t.TempDir(), "ddl"+strconv.Itoa(os.Getpid()))
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := servers.Close(); err != nil {
			t.Error(err)
		}
	})
	started := time.Now()
	index := 0
	for _, c := range vectors.Cases {
		for _, db := range []string{"mysql", "postgres", "sqlite"} {
			statements, steps := c.Statements[db], c.Behavior
			if len(statements) == 0 {
				t.Errorf("%s has no %s statements", c.ID, db)
				continue
			}
			probe := Probe{
				ID:   db + ".ddl." + strings.ReplaceAll(c.ID, "-", "_"),
				DB:   db,
				Fact: "the rendered statements of " + c.ID + " apply and behave as the vector states",
				Run: func(e *Env) {
					e.Exec(connectionRules[db]...)
					e.Exec(statements...)
					for _, step := range steps {
						if len(step.Dialects) > 0 && !slices.Contains(step.Dialects, db) {
							continue
						}
						switch {
						case step.Query != "":
							e.Want(step.Query, step.Want)
						case step.Fails:
							e.FailsAny(step.SQL)
						default:
							e.Exec(step.SQL)
						}
					}
				},
			}
			index++
			t.Run(probe.ID, func(t *testing.T) {
				runProbeCase(t, servers, probe, index, fmt.Sprintf("%d statements, %d behavior steps", len(statements), len(steps)))
			})
		}
	}
	t.Logf("summary: %d vectors on three databases in %s", len(vectors.Cases), time.Since(started).Round(time.Millisecond))
}
