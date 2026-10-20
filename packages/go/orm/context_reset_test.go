package orm

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestTransactionReportsFailedLocalReset checks that when the MySQL local value at the end of a transaction
// reset fails, commit and rollback return that error. MySQL
// user variables persist after COMMIT and ROLLBACK, so
// hiding the failure of (mysql.context.user_variable_session_scope) would leave the value
// on the pool connection.
func TestTransactionReportsFailedLocalReset(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := os.Getenv("ORM_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers")
	}
	useFailingDriver(t, "mysql")
	inject(t, injectedFailure{statement: func(query string) bool {
		return strings.HasPrefix(query, "SET @`orm.") && strings.HasSuffix(query, "= NULL")
	}})
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "contracts", "fixtures", "bench", "bench.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := ConnectSchema(dsn, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	err = db.Transaction(func() error { return db.Utils().SetLocal("ormtest.actor", "tester") })
	if !errors.Is(err, errStatementRejected) {
		t.Fatalf("commit: want the reset error, got %v", err)
	}
	failure := errors.New("callback failed")
	err = db.Transaction(func() error {
		if err := db.Utils().SetLocal("ormtest.actor", "tester"); err != nil {
			return err
		}
		return failure
	})
	if ErrorCode(err) != CodeRollback || !strings.Contains(err.Error(), failure.Error()) || !strings.Contains(err.Error(), errStatementRejected.Error()) {
		t.Fatalf("rollback: want ROLLBACK with the callback and the reset error, got %v", err)
	}
}
