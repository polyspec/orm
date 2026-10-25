package orm_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: INT-52, INT-53.
func TestWasInsertedTracksGeneratedRows(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "clock")
	eachDatabase(t, []string{"sqlite", "mysql", "postgres"}, s, 1, func(t *testing.T, driver, _ string, db *orm.DB) {
		records := rowEntity("clock_event", s, clockColumns...)
		waiting, err := db.Utils().BackendWaitingForLock(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			t.Fatalf("%s reported a backend waiting for a lock with no waiter", driver)
		}
		if err := db.Transaction(func() error {
			c := orm.NewCore(records)
			c.Set("label", "outer")
			created, err := c.Create()
			if err != nil {
				return err
			}
			seq := as[int64](t, as[*keywordRow](t, created).vals["seq"])
			inserted, err := db.Utils().WasInserted("clock_event", seq)
			if err != nil || !inserted {
				return fmt.Errorf("%s: outer insert was not recorded: inserted=%v err=%w", driver, inserted, err)
			}
			missing, err := db.Utils().WasInserted("clock_event", seq+1000)
			if err != nil || missing {
				return fmt.Errorf("%s: a key never inserted was recorded: inserted=%v err=%w", driver, missing, err)
			}
			var nestedSeq int64
			err = db.Transaction(func() error {
				inner := orm.NewCore(records)
				inner.Set("label", "nested")
				row, createErr := inner.Create()
				if createErr != nil {
					return createErr
				}
				nestedSeq = as[int64](t, as[*keywordRow](t, row).vals["seq"])
				ok, checkErr := db.Utils().WasInserted("clock_event", nestedSeq)
				if checkErr != nil || !ok {
					return fmt.Errorf("%s: nested insert was not recorded: inserted=%v err=%w", driver, ok, checkErr)
				}
				return errors.New("rollback nested savepoint")
			}, orm.Retry(0))
			if err == nil {
				return fmt.Errorf("%s: nested transaction unexpectedly committed", driver)
			}
			ok, checkErr := db.Utils().WasInserted("clock_event", nestedSeq)
			if checkErr != nil {
				return checkErr
			}
			if ok {
				return fmt.Errorf("%s: nested insert remained in the write set after savepoint rollback", driver)
			}
			ok, checkErr = db.Utils().WasInserted("clock_event", seq)
			if checkErr != nil || !ok {
				return fmt.Errorf("%s: outer insert was not retained after nested rollback: inserted=%v err=%w", driver, ok, checkErr)
			}
			return nil
		}, orm.Retry(0)); err != nil {
			t.Fatal(err)
		}
	})
}

// Requirements: INT-53.
func TestBackendWaitingForLockReportsPostgresWaiter(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "clock")
	dsn := newDatabase(t, "postgres")
	db := connectInstalled(t, dsn, s)
	defer testcase.Close(t, db)
	ent := rowEntity("clock_event", s, clockColumns...)
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
