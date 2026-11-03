// The measurement of PERF-1 on the three databases: native and client p50, ratio, samples, CPU, wall time and machine. A recipe
// states results and not time, so these tests stay native; their reads are the cases of the recipe performance_gate.
package bench

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/pg"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestPerformanceMeasurementMysql measures the hot path on the seeded bench database of mysql; a missing DSN fails by its name.
// Requirements: PERF-1.
func TestPerformanceMeasurementMysql(t *testing.T) {
	testcase.Start(t, gateDeadline)
	measureHotPath(t, "mysql")
}

// TestPerformanceMeasurementPostgres measures the hot path on the seeded bench database of postgres; a missing DSN fails by its name.
// Requirements: PERF-1.
func TestPerformanceMeasurementPostgres(t *testing.T) {
	testcase.Start(t, gateDeadline)
	measureHotPath(t, "postgres")
}

// TestPerformanceMeasurementSQLite measures the hot path on the seeded bench database of sqlite; a missing DSN fails by its name.
// Requirements: PERF-1.
func TestPerformanceMeasurementSQLite(t *testing.T) {
	testcase.Start(t, gateDeadline)
	measureHotPath(t, "sqlite")
}

// gateDSN is the DSN of the seeded bench database of the entry's database, which the databases need of the run writes after it
// seeds them. A missing variable fails by its name.
func gateDSN(t *testing.T, driver string) string {
	t.Helper()
	name := map[string]string{"mysql": "BENCH_MYSQL_DSN", "postgres": "BENCH_POSTGRES_DSN", "sqlite": "BENCH_SQLITE_DSN"}[driver]
	dsn := os.Getenv(name)
	if dsn == "" {
		t.Fatalf("%s is required; it is the seeded bench database of %s", name, driver)
	}
	return dsn
}

// measureHotPath is the timing of PERF-1 and asserts no correctness: the rows, binds, projection and decoded cells of its
// reads are the cases of contracts/fixtures/performance_gate/performance_gate.json.
func measureHotPath(t *testing.T, driver string) {
	t.Helper()
	dsn := gateDSN(t, driver)
	db, err := model.Connect(dsn, orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	if got := db.Driver(); got != driver {
		t.Fatalf("ORM connection driver = %s, want %s", got, driver)
	}
	raw, err := openMeasuredNative(t, driver, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, raw)
	ctx := context.Background()
	for _, workload := range []struct {
		name  string
		query func() *model.AuthorModel
		rows  int
	}{
		{name: "pk", query: func() *model.AuthorModel {
			return model.Author().Connect(db).Seq(42).Limit(0, 1)
		}, rows: 1},
		{name: "list100", query: func() *model.AuthorModel {
			return model.Author().Connect(db).ServiceSeq(7).AndIsClose(false).OrderBySeqDesc().Limit(0, 100)
		}, rows: 100},
	} {
		clientValues := func() [][2]any {
			rows, err := workload.query().Gets()
			if err != nil {
				t.Fatal(err)
			}
			return testcase.SequenceNameRows(t, rows)
		}
		query, err := workload.query().GetQuery()
		if err != nil {
			t.Fatal(err)
		}
		nativeValues := func() [][2]any {
			rows, err := raw.QueryContext(ctx, query.SQL, query.Binds...)
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, rows)
			values := make([][2]any, 0, workload.rows)
			for rows.Next() {
				var author author
				if err := scan(rows, &author); err != nil {
					t.Fatal(err)
				}
				values = append(values, [2]any{author.Seq, author.Name})
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			return values
		}
		client := func() { clientValues() }
		native := func() { nativeValues() }
		cpuStart, err := processCPUSeconds()
		if err != nil {
			t.Fatalf("read process CPU time before %s: %v", workload.name, err)
		}
		wallStart := time.Now()
		na, cl, ratio := pairedRatio(t, native, client)
		wall := time.Since(wallStart)
		cpuEnd, err := processCPUSeconds()
		if err != nil {
			t.Fatalf("read process CPU time after %s: %v", workload.name, err)
		}
		cpu := cpuEnd - cpuStart
		machine := fmt.Sprintf("%s %s", runtime.GOOS, runtime.GOARCH)
		fmt.Fprintf(os.Stderr, "PERF hot_path_gate go %s %s: native p50=%.1fµs client p50=%.1fµs ratio=%.2f samples=%d cpu=%.1fms wall=%.1fms machine=%s reference=not-recorded\n", driver, workload.name, float64(na.Microseconds()), float64(cl.Microseconds()), ratio, gatePairs, cpu*1000, float64(wall.Microseconds())/1000, machine)
	}
}

func openMeasuredNative(t *testing.T, driver, dsn string) (*sql.DB, error) {
	t.Helper()
	switch driver {
	case "mysql":
		native, err := nativeDSN(dsn)
		if err != nil {
			return nil, err
		}
		return sql.Open("mysql", native)
	case "postgres":
		return sql.Open("pgx", dsn)
	case "sqlite":
		uri, err := url.Parse(dsn)
		if err != nil {
			return nil, err
		}
		path := uri.Path
		if path == "" {
			return nil, fmt.Errorf("SQLite DSN has no path")
		}
		return sql.Open("sqlite", path)
	default:
		return nil, fmt.Errorf("unsupported coverage database %q", driver)
	}
}
