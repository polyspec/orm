package orm_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/internal/dialects"
	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// requireDSN returns the DSN in env; an unset variable fails the test.
func requireDSN(t *testing.T, env string) string {
	t.Helper()
	dsn := os.Getenv(env)
	if dsn == "" {
		t.Fatalf("%s is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers", env)
	}
	return dsn
}

// requireTarget fails the test when the DSN of a MySQL or PostgreSQL target
// is unset.
func requireTarget(t *testing.T, driver, dsn string) {
	t.Helper()
	if dsn == "" && driver != "sqlite" {
		t.Fatalf("ORM_TEST_%s_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers", strings.ToUpper(driver))
	}
}

// openNative opens the MySQL or PostgreSQL database of a client DSN through
// the native database/sql driver.
func openNative(t *testing.T, driver, dsn string) *sql.DB {
	t.Helper()
	return testdb.Open(t, driver, dsn)
}

// openRaw opens the database of dsn through database/sql: SQLite by its file,
// MySQL and PostgreSQL through the native driver.
func openRaw(t *testing.T, driver, dsn string) *sql.DB {
	t.Helper()
	if driver != "sqlite" {
		return openNative(t, driver, dsn)
	}
	raw, err := sql.Open("sqlite", strings.TrimPrefix(dsn, "sqlite://"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// newDatabase returns the DSN of a case database of its own for driver
// (internal/testdb): a new MySQL or PostgreSQL database on the server of
// ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN, or a new SQLite file, dropped
// when the test ends.
func newDatabase(t *testing.T, driver string) string {
	t.Helper()
	return testdb.New(t, driver)
}

// connectInstalled connects to dsn with the schema s and installs s into the
// database; a failure closes the handle and fails the test. The caller closes
// the returned handle.
func connectInstalled(t *testing.T, dsn string, s *orm.Schema) *orm.DB {
	t.Helper()
	return connectInstalledConfig(t, dsn, s, orm.Config{})
}

// connectInstalledConfig connects to dsn with the schema s and the configuration
// cfg, and installs s into the database; a failure closes the handle and fails
// the test. The caller closes the returned handle.
func connectInstalledConfig(t *testing.T, dsn string, s *orm.Schema, cfg orm.Config) *orm.DB {
	t.Helper()
	db := connectSchemaConfig(t, dsn, s, cfg)
	if err := db.Utils().Schema().Install(s); err != nil {
		testcase.Close(t, db)
		t.Fatal(err)
	}
	return db
}

// connectSchemaDB connects to dsn with the schema s; a failure fails the test.
// The caller closes the returned handle.
func connectSchemaDB(t *testing.T, dsn string, s *orm.Schema) *orm.DB {
	t.Helper()
	return connectSchemaConfig(t, dsn, s, orm.Config{})
}

// connectSchemaConfig connects to dsn with the schema s and the configuration
// cfg; a failure fails the test. The caller closes the returned handle.
func connectSchemaConfig(t *testing.T, dsn string, s *orm.Schema, cfg orm.Config) *orm.DB {
	t.Helper()
	db, err := orm.ConnectSchema(dsn, s, cfg)
	if err != nil {
		t.Fatal(err)
	}
	return db
}

// openSchemaDB connects to dsn with the schema s and installs s into the
// database; the handle is closed when the test ends, and a failure fails the
// test.
func openSchemaDB(t *testing.T, dsn string, s *orm.Schema) *orm.DB {
	t.Helper()
	return openSchemaDBConfig(t, dsn, s, orm.Config{})
}

// openSchemaDBConfig is openSchemaDB with the configuration cfg: the handle is
// closed when the test ends.
func openSchemaDBConfig(t *testing.T, dsn string, s *orm.Schema, cfg orm.Config) *orm.DB {
	t.Helper()
	db := connectInstalledConfig(t, dsn, s, cfg)
	t.Cleanup(func() { testcase.Close(t, db) })
	return db
}

// createZoneRow creates one row of the zone table through db, with start_dt at
// the current time in UTC; a failure fails the test.
func createZoneRow(t *testing.T, db *orm.DB, ent *orm.Entity) {
	t.Helper()
	createZoneRowAt(t, db, ent, time.Now().UTC().Format(time.DateTime))
}

// createZoneRowAt creates one row of the zone table through db, with start_dt
// set to start; a failure fails the test.
func createZoneRowAt(t *testing.T, db *orm.DB, ent *orm.Entity, start string) {
	t.Helper()
	row := orm.NewCore(ent)
	ent.New(row)
	row.Connect(db)
	row.Set("start_dt", start)
	if _, err := row.Create(); err != nil {
		t.Fatal(err)
	}
}

// getBySeq reads the row of seq through a core of model; a failed read fails
// the test, and a row that is gone is nil.
func getBySeq(t *testing.T, model func() *orm.Core, seq any) orm.Model {
	t.Helper()
	q := model()
	q.AddAllColumns()
	q.Where("", []orm.ChainKey{{Column: "seq"}}, seq)
	row, err := q.Get()
	if err != nil {
		t.Fatal(err)
	}
	return row
}

// coreFunc returns the model constructor of ent: each call makes a new core
// connected to db.
func coreFunc(db *orm.DB, ent *orm.Entity) func() *orm.Core {
	return func() *orm.Core {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		return c
	}
}

// openNativeSQLite opens the SQLite file of dsn through database/sql with the
// query suffix appended to its path; MySQL and PostgreSQL go to openNative.
func openNativeSQLite(t *testing.T, driver, dsn, suffix string) *sql.DB {
	t.Helper()
	if driver != "sqlite" {
		return openNative(t, driver, dsn)
	}
	path, _, _ := strings.Cut(strings.TrimPrefix(dsn, "sqlite://"), "?")
	raw, err := sql.Open("sqlite", path+suffix)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// queryRows reads all rows of the query as strings, with the column names. NULL is "NULL".
func queryRows(t *testing.T, raw *sql.DB, query string) ([]string, [][]string) {
	t.Helper()
	rows, err := raw.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, rows)
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	var out [][]string
	for rows.Next() {
		row, err := dialects.ScanCells(rows, len(columns))
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return columns, out
}

// auditDB connects to dsn with the audit configuration and installs s; the
// handle is closed when the test ends.
func auditDB(t *testing.T, dsn string, s *orm.Schema) *orm.DB {
	t.Helper()
	return openSchemaDBConfig(t, dsn, s, auditConfig("default"))
}

// checkStatementsJSON fails the test unless got and want encode to the same JSON
// and the case has statements (n is the number of expected statements).
func checkStatementsJSON(t *testing.T, dialect string, got, want any, n int) {
	t.Helper()
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if n == 0 || string(gotJSON) != string(wantJSON) {
		t.Fatalf("%s statements:\n got %s\nwant %s", dialect, gotJSON, wantJSON)
	}
}

// eachDatabase runs body as a subtest of each driver in drivers, in a new case
// database of that driver with the schema s installed the given number of times.
// The subtest logs its start and its end with the time it took.
func eachDatabase(t *testing.T, drivers []string, s *orm.Schema, installs int, body func(t *testing.T, driver, dsn string, db *orm.DB)) {
	t.Helper()
	for _, driver := range drivers {
		t.Run(driver, func(t *testing.T) {
			start := time.Now()
			t.Logf("start %s", driver)
			defer func() { t.Logf("end %s in %s", driver, time.Since(start)) }()
			dsn := newDatabase(t, driver)
			db := connectSchemaDB(t, dsn, s)
			defer testcase.Close(t, db)
			for i := 0; i < installs; i++ {
				if err := db.Utils().Schema().Install(s); err != nil {
					t.Fatalf("install %d: %v", i+1, err)
				}
			}
			body(t, driver, dsn, db)
		})
	}
}
