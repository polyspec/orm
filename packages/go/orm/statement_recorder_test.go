package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
)

// subscribeStatementEvents subscribes to the statement events of db and returns the events recorded so far and the
// unsubscribe function. The events are read through the pointer after the statements run.
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
