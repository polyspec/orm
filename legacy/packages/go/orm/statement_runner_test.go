package orm_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// The statement runner of INT-150 is the recipe contracts/fixtures/statement_runner/statement_runner.json, whose cases every runtime
// runs (recipe_statement_runner_test.go). This file holds what a recipe cannot: a frame kept past its callback.

// TestStatementRunnerFrameAfterItsTransactionEnded checks that a frame kept past the end of its transaction refuses a statement
// with CONFIG, and sends none. A recipe cannot hold it: a Rust frame cannot outlive its callback.
// Requirements: INT-150a.
func TestStatementRunnerFrameAfterItsTransactionEnded(t *testing.T) {
	testcase.Start(t)
	db, err := orm.Connect(newDatabase(t, "sqlite"), orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	var kept *orm.TxFrame
	if err := db.Utils().Run(func(f *orm.TxFrame) error {
		kept = f
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	events, unsubscribe := subscribeStatementEvents(t, db)
	defer unsubscribe()
	if _, err := kept.Run(orm.KindUtility, nil, "SELECT 1"); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("a frame after its transaction ended = %v, want CONFIG", err)
	}
	if len(*events) != 0 {
		t.Fatalf("a frame after its transaction ended sent %d statements, want none", len(*events))
	}
}

// subscribeStatementEvents subscribes to the statement events of db and returns the events recorded so far and the
// unsubscribe function. The events are read through the pointer after the statements run; statement_fault_test.go uses it too.
func subscribeStatementEvents(t *testing.T, db *orm.DB) (*[]orm.StatementEvent, func()) {
	t.Helper()
	var events []orm.StatementEvent
	unsubscribe, err := db.Subscribe(func(e orm.StatementEvent) error {
		events = append(events, e)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return &events, unsubscribe
}
