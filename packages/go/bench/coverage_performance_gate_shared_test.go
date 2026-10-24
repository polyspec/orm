//go:build featurecoverage

package bench

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"reflect"
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

func coverageHotPathGate(t *testing.T, expected string) {
	t.Helper()
	dsn := os.Getenv("ORM_FEATURE_DSN")
	driver := os.Getenv("ORM_FEATURE_DATABASE")
	if dsn == "" || driver == "" {
		t.Fatal("ORM_FEATURE_DSN and ORM_FEATURE_DATABASE are required; run this case through make feature-check")
	}
	if driver != expected {
		t.Fatalf("coverage entrypoint expects %s, received %s", expected, driver)
	}
	db, err := model.Connect(dsn, orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	if got := db.Driver(); got != driver {
		t.Fatalf("ORM connection driver = %s, want %s", got, driver)
	}
	raw, err := openCoverageNative(t, driver, dsn)
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
			values := make([][2]any, 0, rows.Len())
			for _, row := range rows.Slice() {
				seq, err := row.GetSeq()
				if err != nil {
					t.Fatal(err)
				}
				name, err := row.GetName()
				if err != nil {
					t.Fatal(err)
				}
				values = append(values, [2]any{seq, name})
			}
			return values
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
			defer rows.Close()
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
		clientInitial, nativeInitial := clientValues(), nativeValues()
		if !reflect.DeepEqual(clientInitial, nativeInitial) {
			t.Fatalf("%s client rows differ from native rows: client=%v native=%v", workload.name, clientInitial, nativeInitial)
		}
		if len(clientInitial) != workload.rows {
			t.Fatalf("%s client rows = %d, want %d", workload.name, len(clientInitial), workload.rows)
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

func openCoverageNative(t *testing.T, driver, dsn string) (*sql.DB, error) {
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
