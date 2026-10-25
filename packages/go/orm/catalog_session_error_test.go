package orm

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/testcase"
)

func catalogSessionWithOpenTransaction(t *testing.T) *catalogSession {
	t.Helper()
	useFailingDriver(t, "sqlite")
	pool, err := sql.Open("orm-failing-sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testcase.Close(t, pool) })
	ctx := context.Background()
	conn, err := pool.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := conn.Close(); err != nil && !errors.Is(err, sql.ErrConnDone) {
			t.Errorf("close *sql.Conn: %v", err)
		}
	})
	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		t.Fatal(err)
	}
	return &catalogSession{ctx: ctx, conn: conn, dialect: "sqlite"}
}

// Requirements: INT-72.
func TestCatalogSessionEndPreservesPrimaryAndRollbackCauses(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	session := catalogSessionWithOpenTransaction(t)
	inject(t, injectedFailure{rollback: true})

	primaryCause := errors.New("catalog query failed")
	primary := &ir.Error{Code: catalogCodeMetadata, Msg: "primary catalog failure", Cause: primaryCause}
	err := session.end(primary)
	if ErrorCode(err) != catalogCodeMetadata {
		t.Fatalf("primary error code = %q, want %q", ErrorCode(err), catalogCodeMetadata)
	}
	if !errors.Is(err, primaryCause) {
		t.Fatalf("primary cause was lost: %v", err)
	}
	if !strings.Contains(err.Error(), CodeRowRollbackFailed) {
		t.Fatalf("rollback code is missing: %v", err)
	}
	if !errors.Is(err, errRollbackRejected) {
		t.Fatalf("rollback driver cause was lost: %v", err)
	}
}

// Requirements: INT-72.
func TestCatalogSessionEndReportsRollbackCauseWithoutPrimary(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	session := catalogSessionWithOpenTransaction(t)
	inject(t, injectedFailure{rollback: true})

	err := session.end(nil)
	if ErrorCode(err) != CodeRowRollbackFailed {
		t.Fatalf("rollback error code = %q, want %q", ErrorCode(err), CodeRowRollbackFailed)
	}
	if !errors.Is(err, errRollbackRejected) {
		t.Fatalf("rollback driver cause was lost: %v", err)
	}
}

func TestCatalogInsertPreservesIndeterminateCommitCause(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	useFailingDriver(t, "sqlite")
	catalog, metadata := openCatalogSQLiteDefaultFixture(t, "commit_cause", "CREATE TABLE commit_cause (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)")
	inject(t, injectedFailure{statement: func(query string) bool { return query == "COMMIT" }})

	_, err := catalog.InsertRow(context.Background(), metadata, []CatalogAssignment{{Name: "payload", Value: "value"}})
	if ErrorCode(err) != catalogCodeCommitUnknown {
		t.Fatalf("InsertRow commit error code = %q (%v), want %s", ErrorCode(err), err, catalogCodeCommitUnknown)
	}
	if !errors.Is(err, errStatementRejected) {
		t.Fatalf("InsertRow lost the native commit cause: %v", err)
	}
}
