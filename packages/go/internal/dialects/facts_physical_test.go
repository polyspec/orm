//go:build physical

package dialects

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/testcase"
)

// probeDeadline bounds one probe, including its DDL and catalog queries.
const probeDeadline = 30 * time.Second

// schemaTextOf returns the schema text of an introspected document, or the empty
// text when the document has no table.
func schemaTextOf(document *dbspec.Document) string {
	if len(document.Tables) == 0 {
		return ""
	}
	m, _ := dbspec.ManifestOf([]*dbspec.Document{document})
	return m.SchemaText
}

// uniqueToken returns a token that names a physical test run: the process id and
// a random value, so that the names do not overlap with another run at the same time.
func uniqueToken(t *testing.T) string {
	t.Helper()
	random := make([]byte, 4)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	return strconv.Itoa(os.Getpid()) + "_" + hex.EncodeToString(random)
}

// testDSNs returns the MySQL and PostgreSQL DSNs of the physical tests from the
// environment; an unset DSN fails the test.
func testDSNs(t *testing.T) (string, string) {
	t.Helper()
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV")
	}
	return mysqlDSN, postgresDSN
}

// runDDLSteps runs the steps of a DDL vector on the database db: a step of other
// dialects is skipped, a query is compared with its wanted value, a failing
// statement is noted, and any other statement is run.
func runDDLSteps(e *Env, db string, steps []ddlStep) {
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
}

// openTestServers opens the MySQL and PostgreSQL servers of a physical test
// run, named by run; the servers are closed when the test ends.
func openTestServers(t *testing.T, mysqlDSN, postgresDSN, run string) *Servers {
	t.Helper()
	connect, cancel := context.WithTimeout(context.Background(), probeDeadline)
	servers, err := OpenServers(connect, mysqlDSN, postgresDSN, t.TempDir(), run)
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := servers.Close(); err != nil {
			t.Error(err)
		}
	})
	return servers
}

// cleanupDeadline bounds dropping one probe's database, schema or file.
const cleanupDeadline = 30 * time.Second

// TestDialectFacts runs every probe against the databases of TEST_ENV:
// ORM_TEST_MYSQL_DSN, ORM_TEST_POSTGRES_DSN, and a SQLite file per probe in a
// temporary directory. Each probe reports its start, result and elapsed time
// and fails on its own deadline.
func TestDialectFacts(t *testing.T) {
	// The test of DIA-4, DIA-5, DIA-9, DIA-13, DIA-36, DIA-38, DIA-39, DIA-40, DIA-41, DIA-42, DIA-43, DIA-44,
	// DIA-45, DIA-46, DIA-47, DIA-48, DIA-49, DIA-50, DIA-51, DIA-52, DIA-53, DIA-54, DIA-55, DIA-56, DIA-58,
	// DIA-59, DIA-60, DIA-61, DIA-62, DIA-63, DIA-64, DIA-65, DIA-66, DIA-67, DIA-68, DIA-69, DIA-70, DIA-72,
	// DIA-73, DIA-74, DIA-75, DIA-76, DIA-77, DIA-78, DIA-79, DIA-80, DIA-81, DIA-82, DIA-83, DIA-84, DIA-85,
	// DIA-86, DIA-87, DIA-88, DIA-89, DIA-90, DIA-91, DIA-92, DIA-93, DIA-94, DIA-95, DIA-96, DIA-98, DIA-99,
	// DIA-100, DIA-101, DIA-102, DIA-103, DIA-104, DIA-105, DIA-106, DIA-107, DIA-109, DIA-110, DIA-111, DIA-144
	// and DSL-142 (docs/spec).
	testcase.Group(t)
	mysqlDSN, postgresDSN := testDSNs(t)
	probes := All()
	if err := Validate(probes); err != nil {
		t.Fatal(err)
	}
	servers := openTestServers(t, mysqlDSN, postgresDSN, strconv.Itoa(os.Getpid()))
	for _, db := range []string{"mysql", "postgres"} {
		if err := servers.Unreachable(db); err != nil {
			t.Errorf("%s is unreachable; each of its probes fails: %v", db, err)
		}
	}
	type tally struct{ passed, failed int }
	counts := map[string]*tally{"mysql": {}, "postgres": {}, "sqlite": {}}
	started := time.Now()
	for index, probe := range probes {
		t.Run(probe.ID, func(t *testing.T) {
			if runProbeCase(t, servers, probe, index, probe.Fact) {
				counts[probe.DB].passed++
			} else {
				counts[probe.DB].failed++
			}
		})
	}
	for _, db := range []string{"mysql", "postgres", "sqlite"} {
		t.Logf("summary %s: %d passed, %d failed", db, counts[db].passed, counts[db].failed)
	}
	t.Logf("summary all: %d probes in %s", len(probes), time.Since(started).Round(time.Millisecond))
}

// probeCaseDeadline is the deadline of the case that runs one probe. It adds to the probe's own probeDeadline
// the cleanupDeadline by which a probe past its deadline deletes its own database, schema, and file.
const probeCaseDeadline = probeDeadline + cleanupDeadline

// runProbeCase runs one probe as a case under its own deadline, and reports the detail and
// the notes the probe observed as steps. It returns true if the probe passes.
func runProbeCase(t *testing.T, servers *Servers, probe Probe, index int, detail string) bool {
	t.Helper()
	c := testcase.Start(t, probeCaseDeadline)
	if detail == "" {
		c.Step("start on %s", probe.DB)
	} else {
		c.Step("start on %s: %s", probe.DB, detail)
	}
	notes, err := runWithDeadline(servers, probe, index)
	for _, note := range notes {
		c.Step("observed %s", note)
	}
	if err != nil {
		t.Error(err)
		return false
	}
	return true
}

// runWithDeadline runs one probe and fails when the probe does not finish
// before probeDeadline. Cleanup has its own deadline so a probe that timed
// out still drops its objects.
func runWithDeadline(servers *Servers, probe Probe, index int) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), probeDeadline)
	defer cancel()
	cleanup, cancelCleanup := context.WithTimeout(context.Background(), probeDeadline+cleanupDeadline)
	defer cancelCleanup()
	type result struct {
		notes []string
		err   error
	}
	done := make(chan result, 1)
	go func() {
		notes, err := servers.Run(ctx, cleanup, probe, index)
		done <- result{notes, err}
	}()
	select {
	case r := <-done:
		return r.notes, r.err
	case <-ctx.Done():
		r := <-done // the probe observes the cancelled context and drops its objects
		return r.notes, errors.Join(fmt.Errorf("deadline %s exceeded", probeDeadline), r.err)
	}
}
