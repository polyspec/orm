package orm_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// Requirements: INT-53.
func TestBackendWaitingForLockReportsPostgresWaiter(t *testing.T) {
	testcase.Start(t, testcase.Database)
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

	waiterDB := connectSchemaDB(t, dsn, s)
	defer testcase.Close(t, waiterDB)
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
		monitor := openNative(t, "postgres", dsn)
		defer testcase.Close(t, monitor)
		before, err := waiters(monitor, "postgres")
		if err != nil {
			return err
		}
		go func() {
			child := orm.NewCore(ent)
			child.Set("seq", seq)
			child.Set("label", "child")
			child.Connect(waiterDB)
			childDone <- child.Update(nil)
		}()
		childStarted = true
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		if err := awaitLockWait(ctx, monitor, "postgres", before); err != nil {
			return fmt.Errorf("the child update did not wait on the held row: %w", err)
		}
		waiting, err = db.Utils().BackendWaitingForLock(ctx)
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
			select {
			case <-childDone:
			case <-time.After(10 * time.Second):
				t.Errorf("waiting child did not stop after the parent transaction rolled back: %v", err)
			}
		}
		t.Fatal(err)
	}
	if !waiting {
		t.Fatal("PostgreSQL did not report the backend waiting for the row lock")
	}
	select {
	case err := <-childDone:
		if err != nil {
			t.Fatalf("waiting child update: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("waiting child did not finish after the parent transaction released the row")
	}
}
