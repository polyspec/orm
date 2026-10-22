package orm_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/pg"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestListenNotify runs LISTEN and NOTIFY on PostgreSQL. A notification sent
// inside a transaction is delivered with its commit and dropped by a rollback;
// a notification sent outside one is delivered at once; unlisten stops a
// channel; a receive whose context is cancelled returns CANCELED; and MySQL and
// SQLite refuse notify, listen and unlisten with CAPABILITY_UNSUPPORTED.
// Requirements: DIA-192, DIA-193, DIA-194, DIA-195, DIA-196, PRT-74.
func TestListenNotify(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := newDatabase(t, "postgres")
	db, err := orm.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sub, err := db.WithContext(ctx).Listen("t229_events")
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, sub)

	if err := db.Transaction(func() error { return db.Notify("t229_events", "committed") }); err != nil {
		t.Fatal(err)
	}
	got, err := sub.Receive()
	if err != nil {
		t.Fatal(err)
	}
	if got.Channel != "t229_events" || got.Payload != "committed" {
		t.Fatalf("received %+v; want the committed notification", got)
	}

	rolled := db.Transaction(func() error {
		if err := db.Notify("t229_events", "rolled back"); err != nil {
			return err
		}
		return errors.New("roll back")
	})
	if rolled == nil {
		t.Fatal("the transaction that fails returned no error")
	}
	if err := db.Notify("t229_events", "outside"); err != nil {
		t.Fatal(err)
	}
	got, err = sub.Receive()
	if err != nil {
		t.Fatal(err)
	}
	if got.Payload != "outside" {
		t.Fatalf("received %q; the rolled back notification must not arrive", got.Payload)
	}

	if err := sub.Unlisten("t229_events"); err != nil {
		t.Fatal(err)
	}
	if err := db.Notify("t229_events", "after unlisten"); err != nil {
		t.Fatal(err)
	}

	cancelled, stop := context.WithCancel(context.Background())
	waiting, err := db.WithContext(cancelled).Listen("t229_cancel")
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, waiting)
	stop()
	if _, err := waiting.Receive(); orm.ErrorCode(err) != orm.CodeCanceled {
		t.Fatalf("a receive on a cancelled context returned %v; want CANCELED", err)
	}

	for _, driver := range []string{"sqlite", "mysql"} {
		other, err := orm.Connect(newDatabase(t, driver), orm.Config{})
		if err != nil {
			t.Fatal(err)
		}
		if err := other.Notify("t229_events", "x"); orm.ErrorCode(err) != orm.CodeCapabilityUnsupported {
			t.Fatalf("%s notify returned %v; want CAPABILITY_UNSUPPORTED", driver, err)
		}
		if _, err := other.Listen("t229_events"); orm.ErrorCode(err) != orm.CodeCapabilityUnsupported {
			t.Fatalf("%s listen returned %v; want CAPABILITY_UNSUPPORTED", driver, err)
		}
		testcase.Close(t, other)
	}
}
