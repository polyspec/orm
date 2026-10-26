//go:build featurecoverage

package model_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageConformanceVector runs, on the database the Go conformance runner chose,
// only the selected vectors, and checks that each output equals
// the recorded expect of the database and the JSON value.
// Requirements: DIA-37, DSL-137, DSL-139, DSL-144, DIA-11, DIA-14.
func TestCoverageConformanceVector(t *testing.T) {
	testcase.Start(t, testcase.Process)
	driver, dsn := featureDatabase(t)
	root := filepath.Join("..", "..", "..")
	names := []string{"conditions_values", "relations", "functions", "creates_and_save"}
	expectFile := map[string]string{
		"mysql":    "vectors.json",
		"postgres": "vectors.postgres.json",
		"sqlite":   "vectors.sqlite.json",
	}[driver]
	recorded := readRecorded(t, root, expectFile)
	expect := map[string]any{}
	for _, v := range recorded.Vectors {
		if slices.Contains(names, v.Name) {
			if _, seen := expect[v.Name]; seen || v.Expect == nil {
				t.Fatalf("%s: vector %s is repeated or has no expect", expectFile, v.Name)
			}
			expect[v.Name] = v.Expect
		}
	}

	args := []string{"./packages/go/internal/conformance", "-dsn", dsn}
	for _, name := range names {
		args = append(args, "-vector", name)
	}
	output := runConformanceGo(t, root, dsn, args...)
	if len(output) != len(names) {
		t.Fatalf("runner_go printed %d vectors, want %v", len(output), names)
	}
	for _, name := range names {
		want, ok := expect[name]
		if !ok {
			t.Fatalf("%s has no vector %s", expectFile, name)
		}
		got, ok := output[name]
		if !ok {
			t.Fatalf("runner_go did not print vector %s", name)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("vector %s on %s:\n got %v\nwant %v", name, driver, got, want)
		}
	}
}

// TestCoverageConformanceMySQL runs every vector of tests/conformance/vectors.json on the MySQL
// bench database (BENCH_MYSQL_DSN) and checks each as a subtest named by the vector.
// Requirements: PRT-68, INT-20, INT-21, INT-22, INT-23, INT-24, INT-25, INT-26, INT-39, DIA-24.
func TestCoverageConformanceMySQL(t *testing.T) {
	testcase.Start(t, testcase.Process)
	runConformanceVectors(t, "BENCH_MYSQL_DSN", "vectors.json")
}

// TestCoverageConformancePostgres runs every vector of tests/conformance/vectors.postgres.json on
// the PostgreSQL bench database (BENCH_POSTGRES_DSN), a subtest per vector.
// Requirements: PRT-68, INT-20, INT-21, INT-22, INT-23, INT-24, INT-25, INT-26, INT-39, DIA-24.
func TestCoverageConformancePostgres(t *testing.T) {
	testcase.Start(t, testcase.Process)
	runConformanceVectors(t, "BENCH_POSTGRES_DSN", "vectors.postgres.json")
}

// TestCoverageConformanceSQLite runs every vector of tests/conformance/vectors.sqlite.json on the
// SQLite bench database (BENCH_SQLITE_DSN), a subtest per vector.
// Requirements: PRT-68, INT-20, INT-21, INT-22, INT-23, INT-24, INT-25, INT-26, INT-39, DIA-24, DBS-115.
func TestCoverageConformanceSQLite(t *testing.T) {
	testcase.Start(t, testcase.Process)
	runConformanceVectors(t, "BENCH_SQLITE_DSN", "vectors.sqlite.json")
}

// runConformanceVectors runs the Go conformance runner once over every vector of the expect file,
// in file order as the conformance check runs it, on the bench database of the DSN variable, and
// compares each printed vector with its recorded expect in a subtest named by the vector. The
// bench database is required; the test never skips without it.
func runConformanceVectors(t *testing.T, dsnVariable, expectFile string) {
	t.Helper()
	dsn := os.Getenv(dsnVariable)
	if dsn == "" {
		t.Fatalf("%s is required: the bench database that the conformance check runs on; run make databases-create, which seeds the bench databases and writes their DSNs", dsnVariable)
	}
	root := filepath.Join("..", "..", "..")
	recorded := readRecorded(t, root, expectFile)
	driver := map[string]string{
		"BENCH_MYSQL_DSN":    "mysql",
		"BENCH_POSTGRES_DSN": "postgres",
		"BENCH_SQLITE_DSN":   "sqlite",
	}[dsnVariable]
	if driver == "" {
		t.Fatalf("unsupported conformance DSN variable %q", dsnVariable)
	}
	withAuditLazyCounterBaseline(t, root, driver, dsn)
	output := runConformanceGo(t, root, dsn, "-tags", "ormtest", "./packages/go/internal/conformance", "-dsn", dsn)
	if len(output) != len(recorded.Vectors) {
		t.Errorf("runner_go printed %d vectors, %s has %d", len(output), expectFile, len(recorded.Vectors))
	}
	for _, v := range recorded.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			if v.Expect == nil {
				t.Fatalf("%s: vector %s has no expect", expectFile, v.Name)
			}
			got, ok := output[v.Name]
			if !ok {
				t.Fatalf("runner_go did not print vector %s", v.Name)
			}
			if !reflect.DeepEqual(got, v.Expect) {
				t.Fatalf("vector %s:\n got %v\nwant %v", v.Name, got, v.Expect)
			}
		})
	}
}

type conformanceCounter struct {
	Value  string `json:"value"`
	Called bool   `json:"called"`
	Owner  string `json:"owner"`
}

// withAuditLazyCounterBaseline temporarily gives the audit_lazy vector its canonical empty-table identity
// counters, then restores every counter to the value that the owner test observed before it ran.
func withAuditLazyCounterBaseline(t *testing.T, root, driver, dsn string) {
	t.Helper()
	original := readConformanceCounters(t, root, driver, dsn)
	t.Cleanup(func() {
		if err := restoreConformanceCounters(root, driver, dsn, original); err != nil {
			t.Errorf("restore %s conformance counters: %v", driver, err)
			return
		}
		current := readConformanceCounters(t, root, driver, dsn)
		if !reflect.DeepEqual(current, original) {
			t.Errorf("conformance counter state changed after the owner run: got %v, want %v", current, original)
		}
	})

	assertAuditLazyTablesEmpty(t, dsn)
	baseline := make(map[string]conformanceCounter, len(original))
	for name, value := range original {
		baseline[name] = value
	}
	for _, table := range []string{"audit_record", "audited_note"} {
		switch driver {
		case "mysql":
			counter, ok := baseline[table]
			if !ok {
				t.Fatalf("MySQL counter snapshot has no %s AUTO_INCREMENT", table)
			}
			counter.Value = "1"
			counter.Called = true
			baseline[table] = counter
		case "postgres":
			found := false
			for name, counter := range baseline {
				if counter.Owner != table {
					continue
				}
				counter.Value = "1"
				counter.Called = false
				baseline[name] = counter
				found = true
			}
			if !found {
				t.Fatalf("PostgreSQL counter snapshot has no sequence owned by %s", table)
			}
		case "sqlite":
			if counter, ok := baseline[table]; ok {
				counter.Value = "0"
				counter.Called = true
				baseline[table] = counter
			}
		default:
			t.Fatalf("unsupported conformance driver %q", driver)
		}
	}
	if err := restoreConformanceCounters(root, driver, dsn, baseline); err != nil {
		t.Fatalf("set the %s audit_lazy counter baseline: %v", driver, err)
	}
}

func assertAuditLazyTablesEmpty(t *testing.T, dsn string) {
	t.Helper()
	db, err := model.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatalf("connect to the conformance database: %v", err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close the conformance database: %v", err)
		}
	}()
	for name, count := range map[string]func() (int64, error){
		"audit_record": func() (int64, error) { return model.AuditRecord().Connect(db).GetCount() },
		"audited_note": func() (int64, error) { return model.AuditedNote().Connect(db).GetCount() },
	} {
		rows, err := count()
		if err != nil {
			t.Fatalf("count %s before audit_lazy: %v", name, err)
		}
		if rows != 0 {
			t.Fatalf("cannot normalize %s identity counter: table has %d rows", name, rows)
		}
	}
}

func readConformanceCounters(t *testing.T, root, driver, dsn string) map[string]conformanceCounter {
	t.Helper()
	command := exec.Command("node", "tests/conformance/check/main.mts", "counters", "--driver", driver, "--dsn", dsn)
	command.Dir = root
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("read %s conformance counters: %v\n%s", driver, err, strings.ReplaceAll(string(output), dsn, "[dsn]"))
	}
	var counters map[string]conformanceCounter
	if err := json.Unmarshal(output, &counters); err != nil {
		t.Fatalf("decode %s conformance counters: %v", driver, err)
	}
	return counters
}

func restoreConformanceCounters(root, driver, dsn string, counters map[string]conformanceCounter) error {
	snapshot, err := json.Marshal(counters)
	if err != nil {
		return fmt.Errorf("encode %s counters: %w", driver, err)
	}
	command := exec.Command("node", "tests/conformance/check/main.mts", "counters", "--driver", driver, "--dsn", dsn, "--restore-json", string(snapshot))
	command.Dir = root
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w\n%s", err, strings.ReplaceAll(string(output), dsn, "[dsn]"))
	}
	return nil
}

// readRecorded reads the recorded vectors of the conformance file expectFile under
// tests/conformance of the repository root; a failure fails the test.
func readRecorded(t *testing.T, root, expectFile string) recordedVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, "tests", "conformance", expectFile))
	if err != nil {
		t.Fatal(err)
	}
	var recorded recordedVectors
	if err := json.Unmarshal(raw, &recorded); err != nil {
		t.Fatalf("%s: %v", expectFile, err)
	}
	return recorded
}

// recordedVectors is the vectors of a recorded conformance file.
type recordedVectors struct {
	Vectors []struct {
		Name   string `json:"name"`
		Expect any    `json:"expect"`
	} `json:"vectors"`
}

// runConformanceGo runs the Go conformance runner with the arguments in the
// repository root and returns its output, a JSON object of results. The dsn is
// redacted from a failure's output.
func runConformanceGo(t *testing.T, root, dsn string, args ...string) map[string]any {
	t.Helper()
	cmd := exec.Command("go", append([]string{"run"}, args...)...)
	cmd.Dir = root
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("runner_go: %v\n%s", err, bytes.ReplaceAll(stderr.Bytes(), []byte(dsn), []byte("[redacted]")))
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("runner_go output: %v", err)
	}
	return output
}
