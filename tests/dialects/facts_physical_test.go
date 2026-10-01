//go:build physical

package dialects

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"
)

// probeDeadline bounds one probe, including its DDL and catalog queries.
const probeDeadline = 30 * time.Second

// cleanupDeadline bounds dropping one probe's database, schema or file.
const cleanupDeadline = 30 * time.Second

// TestDialectFacts runs every probe against the databases of TEST_ENV:
// ORM_TEST_MYSQL_DSN, ORM_TEST_POSTGRES_DSN, and a SQLite file per probe in a
// temporary directory. Each probe reports its start, result and elapsed time
// and fails on its own deadline.
func TestDialectFacts(t *testing.T) {
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV")
	}
	probes := All()
	if err := Validate(probes); err != nil {
		t.Fatal(err)
	}
	connect, cancel := context.WithTimeout(context.Background(), probeDeadline)
	servers, err := OpenServers(connect, mysqlDSN, postgresDSN, t.TempDir(), strconv.Itoa(os.Getpid()))
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := servers.Close(); err != nil {
			t.Error(err)
		}
	})
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
			begin := time.Now()
			t.Logf("start %s on %s: %s", probe.ID, probe.DB, probe.Fact)
			notes, err := runWithDeadline(servers, probe, index)
			for _, note := range notes {
				t.Logf("observed %s: %s", probe.ID, note)
			}
			elapsed := time.Since(begin).Round(time.Millisecond)
			if err != nil {
				counts[probe.DB].failed++
				t.Errorf("result %s: FAIL after %s: %v", probe.ID, elapsed, err)
				return
			}
			counts[probe.DB].passed++
			t.Logf("result %s: PASS after %s", probe.ID, elapsed)
		})
	}
	for _, db := range []string{"mysql", "postgres", "sqlite"} {
		t.Logf("summary %s: %d passed, %d failed", db, counts[db].passed, counts[db].failed)
	}
	t.Logf("summary all: %d probes in %s", len(probes), time.Since(started).Round(time.Millisecond))
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
