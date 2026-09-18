//go:build physical

package engine

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/engine/plan"
)

// TestPhysicalQueryForms executes the plans of the ORM functions, tuple
// conditions, subqueries, and placed join conditions on every database and
// requires equal results.
func TestPhysicalQueryForms(t *testing.T) {
	targets := []struct{ driver, dsn string }{
		{"mysql", os.Getenv("ORM_MIGRATION_MYSQL_DSN")},
		{"postgres", os.Getenv("ORM_MIGRATION_POSTGRES_DSN")},
		{"sqlite", filepath.Join(t.TempDir(), "forms.sqlite")},
	}
	for _, target := range targets {
		t.Run(target.driver, func(t *testing.T) {
			if target.dsn == "" {
				t.Fatalf("ORM_MIGRATION_%s_DSN is required; physical DB tests never skip", strings.ToUpper(target.driver))
			}
			testPhysicalQueryForms(t, target.driver, target.dsn)
		})
	}
}

func testPhysicalQueryForms(t *testing.T, driver, dsn string) {
	ctx := context.Background()
	sqlDriver := driver
	if driver == "postgres" {
		sqlDriver = "pgx"
	}
	db, err := sql.Open(sqlDriver, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	exec := func(query string) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	for _, table := range []string{"place", "owner", "visit", "membership"} {
		exec("DROP TABLE IF EXISTS " + table)
		t.Cleanup(func() { _, _ = db.ExecContext(ctx, "DROP TABLE IF EXISTS "+table) })
	}
	point, datetime := "POINT", "DATETIME(6)"
	switch driver {
	case "postgres":
		point, datetime = "point", "timestamp(6)"
	case "sqlite":
		point, datetime = "TEXT", "TEXT"
	}
	exec("CREATE TABLE place (seq BIGINT PRIMARY KEY, owner_seq BIGINT NOT NULL, name VARCHAR(50) NOT NULL, price INT NOT NULL, location " + point + ", created_ts " + datetime + " NOT NULL)")
	exec("CREATE TABLE owner (seq BIGINT PRIMARY KEY, name VARCHAR(50) NOT NULL, min_price INT NOT NULL)")
	exec("CREATE TABLE visit (seq BIGINT PRIMARY KEY, place_seq BIGINT NOT NULL, amount INT NOT NULL, status INT NOT NULL)")
	exec("CREATE TABLE membership (tenant_id INT NOT NULL, account_id INT NOT NULL, role VARCHAR(20) NOT NULL, PRIMARY KEY (tenant_id, account_id))")
	pointValue := func(lon, lat float64) string {
		switch driver {
		case "mysql":
			return fmt.Sprintf("ST_PointFromText('POINT(%g %g)')", lon, lat)
		case "postgres":
			return fmt.Sprintf("point(%g, %g)", lon, lat)
		}
		return fmt.Sprintf("'POINT(%g %g)'", lon, lat)
	}
	recent := time.Now().UTC().Add(-48 * time.Hour).Format("2006-01-02 15:04:05")
	exec("INSERT INTO owner VALUES (1, 'kim bakery', 900), (2, 'lee market', 100)")
	exec("INSERT INTO place VALUES " +
		"(1, 1, 'seoul hall', 1000, " + pointValue(126.978, 37.5665) + ", '2020-01-02 10:00:00'), " +
		"(2, 2, 'busan hall', 50, " + pointValue(129.0756, 35.1796) + ", '" + recent + "')")
	exec("INSERT INTO visit VALUES (1, 1, 30, 1), (2, 1, 20, 1), (3, 1, 99, 0), (4, 2, 5, 1)")
	exec("INSERT INTO membership VALUES (1, 10, 'owner'), (1, 11, 'member'), (2, 10, 'member')")

	e := formsEngine(t, driver)
	run := func(body string, params ...any) [][]any {
		t.Helper()
		p := formsCompile(t, e, body)
		return physicalRows(t, db, driver, p.Steps[0], params)
	}

	rows := run(`"kind":"all","entity":"place","columns":{"mode":"none","fn":{"distance":{"column":"location","fn":{"name":"distance","ps":[0,1]}}}},
	 "where":{"items":[{"pred":{"column":"created_ts","op":"eq","p":2,"fn":{"name":"day_of_week"}}}]},"order":[{"column":"seq"}]`,
		129.0756, 35.1796, 5)
	if len(rows) != 1 || asInt(rows[0][0]) != 1 {
		t.Fatalf("day_of_week rows %v", rows)
	}
	if d := asFloat(rows[0][len(rows[0])-1]); math.Abs(d-325110.5) > 1 {
		t.Fatalf("distance %v", d)
	}

	rows = run(`"kind":"all","entity":"place","columns":{"mode":"none"},
	 "where":{"items":[{"pred":{"column":"created_ts","op":"gt","value":{"name":"days_ago","ps":[0]}}},
	   {"pred":{"conn":"and","column":"created_ts","op":"lte","value":{"name":"now"}}}]}`, 3)
	if len(rows) != 1 || asInt(rows[0][0]) != 2 {
		t.Fatalf("days_ago rows %v", rows)
	}

	rows = run(`"kind":"all","entity":"membership","where":{"items":[{"pred":{"op":"tuple_in","cols":["tenant_id","account_id"],"ps":[0,1,2,3]}}]},
	 "order":[{"column":"tenant_id"},{"column":"account_id"}]`, 1, 10, 2, 10)
	if len(rows) != 2 {
		t.Fatalf("tuple rows %v", rows)
	}

	rows = run(`"kind":"all","entity":"place","columns":{"mode":"none","sub":{"paid":{"agg":"sum","column":"amount","query":{"entity":"visit",
	   "where":{"items":[{"pred":{"column":"place_seq","op":"eq_col","ref":{"path":"^","column":"seq"}}},{"pred":{"conn":"and","column":"status","op":"eq","p":0}}]}}}}},
	 "where":{"items":[{"pred":{"column":"owner_seq","op":"in","sub":{"column":"seq","query":{"entity":"owner",
	   "where":{"items":[{"pred":{"column":"min_price","op":"gt","p":1}}]}}}}}]}`, 1, 500)
	if len(rows) != 1 || asInt(rows[0][0]) != 1 || asInt(rows[0][len(rows[0])-1]) != 50 {
		t.Fatalf("subquery rows %v", rows)
	}

	rows = run(`"kind":"all","entity":"place","columns":{"mode":"none"},
	 "joins":[{"rel":"owner","kind":"left","left":"owner_seq","right":"seq","query":{"entity":"owner","columns":{"mode":"none"},
	   "where":{"items":[{"pred":{"column":"name","op":"contains","p":0}}]}}}],
	 "where":{"items":[{"pred":{"column":"price","op":"gt_col","ref":{"path":"owner","column":"min_price"}}},
	   {"group":{"conn":"and","items":[{"pred":{"column":"name","op":"contains","p":1}},{"joined":{"conn":"or","join":"owner"}}]}}]},
	 "order":[{"column":"seq"}]`, "bakery", "busan")
	if len(rows) != 1 || asInt(rows[0][0]) != 1 {
		t.Fatalf("placed join rows %v", rows)
	}

	rows = run(`"kind":"all","entity":"place","columns":{"mode":"none"},"order":[{"random":true}]`)
	if len(rows) != 2 {
		t.Fatalf("random rows %v", rows)
	}
}

func physicalRows(t *testing.T, db *sql.DB, driver string, st plan.Step, params []any) [][]any {
	t.Helper()
	var args []any
	for _, slot := range st.BindSlots {
		switch slot.From {
		case "param":
			value := params[slot.Param]
			if slot.Transform == "like_contains" {
				value = "%" + fmt.Sprint(value) + "%"
			}
			args = append(args, value)
		case "now":
			args = append(args, time.Now().UTC().Format("2006-01-02 15:04:05"))
		default:
			t.Fatalf("unexpected bind slot %+v", slot)
		}
	}
	rs, err := db.Query(st.SQL, args...)
	if err != nil {
		t.Fatalf("%s: %s: %v", driver, st.SQL, err)
	}
	defer rs.Close()
	cols, _ := rs.Columns()
	var out [][]any
	for rs.Next() {
		row := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range row {
			ptrs[i] = &row[i]
		}
		if err := rs.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rs.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func asInt(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int32:
		return int64(x)
	case float64:
		return int64(x)
	case []byte:
		var n int64
		fmt.Sscan(string(x), &n)
		return n
	case string:
		var n int64
		fmt.Sscan(x, &n)
		return n
	}
	panic(fmt.Sprintf("asInt %T", v))
}

func asFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case []byte:
		var n float64
		fmt.Sscan(string(x), &n)
		return n
	case string:
		var n float64
		fmt.Sscan(x, &n)
		return n
	}
	return float64(asInt(v))
}
