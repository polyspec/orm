package complexquery

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/pg"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"
	"github.com/polyspec/orm/packages/go/testcase"
)

const planChildEnv = "ORM_COMPLEX_QUERY_PLAN_CHILD"

// Requirements: CPX-1.
func TestComplexQueryPublicPlan(t *testing.T) {
	if os.Getenv(planChildEnv) == "1" {
		testcase.Start(t, testcase.Compute)
		runComplexQueryPublicPlan(t)
		return
	}
	testcase.Start(t, testcase.Process)
	cmd := exec.Command(os.Args[0], "-test.run=^TestComplexQueryPublicPlan$")
	cmd.Env = append(os.Environ(), planChildEnv+"=1")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("public query plan child: %v\n%s", err, output)
	}
}

func runComplexQueryPublicPlan(t *testing.T) {
	t.Helper()
	const fakeDriver = "complex-query-plan"
	sql.Register(fakeDriver, queryPlanDriver{})
	orm.RegisterDriver("mysql", fakeDriver, func(err error) error { return err })
	orm.RegisterDriver("postgres", fakeDriver, func(err error) error { return err })
	fixture := readComplexFixture(t)
	for _, test := range []struct {
		driver string
		dsn    string
	}{
		{driver: "mysql", dsn: "mysql://user:pass@localhost/example"},
		{driver: "postgres", dsn: "postgres://user:pass@localhost/example"},
	} {
		t.Run(test.driver, func(t *testing.T) {
			db := openComplexDB(t, test.dsn, orm.Config{})
			statement, err := searchModel(db, inputFromFixture(fixture)).GetQuery()
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{" IN (SELECT ", "product_match_category", "product_brand_lang", "product_lang", "ORDER BY"} {
				if !strings.Contains(statement.SQL, want) {
					t.Errorf("%s public query omits %q:\n%s", test.driver, want, statement.SQL)
				}
			}
			if !strings.Contains(statement.SQL, "MATCH (") && !strings.Contains(statement.SQL, "to_tsvector(") {
				t.Errorf("%s public query omits dialect full-text search:\n%s", test.driver, statement.SQL)
			}
			if strings.Contains(strings.ToUpper(statement.SQL), " JOIN ") || strings.Contains(strings.ToUpper(statement.SQL), "GROUP BY") {
				t.Errorf("%s public query has filter joins or grouping:\n%s", test.driver, statement.SQL)
			}
			if got := strings.Count(strings.ToUpper(statement.SQL), " IN (SELECT "); got != 3 {
				t.Errorf("%s public query has %d semijoins, want 3:\n%s", test.driver, got, statement.SQL)
			}
		})
	}
	db := openComplexDB(t, "sqlite://"+filepath.Join(t.TempDir(), "query-plan.sqlite"), orm.Config{})
	if _, err := searchModel(db, inputFromFixture(fixture)).GetQuery(); orm.ErrorCode(err) != orm.CodeOperatorNotAllowed {
		t.Fatalf("SQLite public query error = %v, want %s", err, orm.CodeOperatorNotAllowed)
	}
}

type queryPlanDriver struct{}

func (queryPlanDriver) Open(string) (driver.Conn, error) { return queryPlanConn{}, nil }

type queryPlanConn struct{}

func (queryPlanConn) Prepare(string) (driver.Stmt, error) {
	return nil, fmt.Errorf("query plan test must not execute SQL")
}
func (queryPlanConn) Close() error { return nil }
func (queryPlanConn) Begin() (driver.Tx, error) {
	return nil, fmt.Errorf("query plan test must not begin transactions")
}
func (queryPlanConn) Ping(context.Context) error { return nil }
