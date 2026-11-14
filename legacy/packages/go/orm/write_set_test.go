package orm_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// Requirements: INT-53.
func TestBackendWaitingForLockReportsPostgresWaiter(t *testing.T) {
	testcase.Start(t)
	s := fixtureSchema(t, "clock")
	dsn := newDatabase(t, "postgres")
	db := connectInstalled(t, dsn, s)
	defer testcase.Close(t, db)
	ent := rowEntity("clock_event", s, "seq", "label", "created_ts")
	var seq int64
	if err := db.Transaction(func() error {
		row := orm.NewCore(ent)
		row.Set("label", "held")
		created, err := row.Create()
		if err != nil {
			return err
		}
		seq = as[int64](t, as[*keywordRow](t, created).vals["seq"])
		return nil
	}, orm.Retry(0)); err != nil {
		t.Fatal(err)
	}

	// The child is a session of the test that reports its lock waits (reportLockWaits, T475): the server sends it the LOG
	// message "still waiting for" while its update waits for the row that the parent holds, and only then the parent reads
	// BackendWaitingForLock once.
	child, childWaits := reportLockWaits(t, dsn)
	childDone := make(chan error, 1)
	childStarted := false
	var waiting bool
	err := db.Transaction(func() error {
		parent := orm.NewCore(ent)
		parent.Set("seq", seq)
		parent.Set("label", "parent")
		if err := parent.Update(nil); err != nil {
			return err
		}
		go func() {
			_, err := child.Exec(context.Background(), `UPDATE clock_event SET label = 'child' WHERE seq = $1`, seq)
			childDone <- err
		}()
		childStarted = true
		select {
		case <-childWaits:
		case err := <-childDone:
			childStarted = false
			return fmt.Errorf("the child update ended before it waited on the held row: %v", err)
		}
		var err error
		waiting, err = db.Utils().BackendWaitingForLock(t.Context())
		if err != nil {
			return err
		}
		if !waiting {
			return errors.New("BackendWaitingForLock did not report the waiting child while the parent held the row")
		}
		return nil
	}, orm.Retry(0))
	if err != nil {
		if childStarted {
			<-childDone
		}
		t.Fatal(err)
	}
	if !waiting {
		t.Fatal("PostgreSQL did not report the backend waiting for the row lock")
	}
	if err := <-childDone; err != nil {
		t.Fatalf("waiting child update: %v", err)
	}
}
