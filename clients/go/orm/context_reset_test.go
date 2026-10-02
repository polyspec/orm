package orm

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
)

// TestTransactionReportsFailedLocalReset는 transaction 끝의 MySQL local 값
// reset이 실패하면 commit과 rollback이 그 오류를 돌려주는지 확인한다. MySQL
// user variable은 COMMIT과 ROLLBACK 뒤에도 남으므로
// (mysql.context.user_variable_session_scope) 실패를 숨기면 pool connection에
// 값이 남는다.
func TestTransactionReportsFailedLocalReset(t *testing.T) {
	dsn := os.Getenv("ORM_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN is required; database tests never skip")
	}
	useFailingDriver(t, "mysql")
	inject(t, injectedFailure{statement: func(query string) bool {
		return strings.HasPrefix(query, "SET @`orm.") && strings.HasSuffix(query, "= NULL")
	}})
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "schema", "bench.dbspec"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := Connect(dsn, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
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
