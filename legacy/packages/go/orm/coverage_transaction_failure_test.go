package orm

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: INT-72.
func TestTransactionFailureRollback(t *testing.T) {
	testcase.Start(t, testcase.Database)
	useFailingDriver(t, "sqlite")
	db := connectBench(t, "sqlite://"+filepath.Join(t.TempDir(), "transaction-failure.sqlite"))
	inject(t, injectedFailure{rollback: true})
	err := db.Transaction(func() error { return errors.New("callback failed") }, Retry(0))
	wantBoth(t, "transaction callback", err, "callback failed", errRollbackRejected.Error())
}

// Requirements: DIA-181, PLN-17.
func TestTransactionFailureSavepointEnd(t *testing.T) {
	testcase.Start(t, testcase.Database)
	useFailingDriver(t, "sqlite")
	db := connectBench(t, "sqlite://"+filepath.Join(t.TempDir(), "savepoint-failure.sqlite"))
	nested := func() error {
		return db.Transaction(func() error {
			return db.Transaction(func() error { return errors.New("callback failed") })
		}, Retry(0))
	}

	for _, statement := range []string{"ROLLBACK TO SAVEPOINT", "RELEASE SAVEPOINT"} {
		t.Run(statement, func(t *testing.T) {
			inject(t, injectedFailure{statement: func(query string) bool { return strings.HasPrefix(query, statement) }})
			wantBoth(t, "savepoint callback", nested(), "callback failed", errStatementRejected.Error())
		})
	}

	inject(t, injectedFailure{statement: func(query string) bool {
		return strings.HasPrefix(query, "ROLLBACK TO SAVEPOINT") || strings.HasPrefix(query, "RELEASE SAVEPOINT")
	}})
	wantBoth(t, "both savepoint end steps", nested(), "callback failed", errStatementRejected.Error())
}
