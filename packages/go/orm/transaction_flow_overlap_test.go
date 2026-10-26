package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestTransactionConnectionRejectsOverlappingStatement checks the transaction executor's statement guard.
// Requirements: DSL-121, PLN-18 (docs/spec/dsl.md "Transactions").
func TestTransactionConnectionRejectsOverlappingStatement(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	tx := &txConn{}
	release, err := tx.enter()
	if err != nil {
		t.Fatalf("first statement entry: %v", err)
	}
	defer release()

	if _, err := tx.enter(); ErrorCode(err) != CodeConfig {
		t.Fatalf("overlapping statement error = %v, want %s", err, CodeConfig)
	}
}
