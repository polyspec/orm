package orm_test

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
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

	for _, channel := range []string{"", strings.Repeat("x", 64), strings.Repeat("é", 32), "bad\x00channel"} {
		if err := db.Notify(channel, "invalid channel"); orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("notify channel %q returned %v; want CONFIG", channel, err)
		}
		if _, err := db.WithContext(ctx).Listen(channel); orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("listen channel %q returned %v; want CONFIG", channel, err)
		}
	}
	if err := db.Notify(strings.Repeat("é", 31), "valid 62-byte channel"); err != nil {
		t.Fatalf("notify on a valid 62-byte UTF-8 channel: %v", err)
	}

	for _, payload := range []string{strings.Repeat("x", 8000), strings.Repeat("x", 8001), strings.Repeat("é", 4000), strings.Repeat("é", 4001), "bad\x00payload"} {
		if err := db.Notify("t229_events", payload); orm.ErrorCode(err) != orm.CodeDriver {
			t.Fatalf("notify invalid payload of %d UTF-8 bytes returned %v; want DRIVER", len(payload), err)
		}
	}
	boundary := strings.Repeat("x", 7999)

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
	if err := db.Notify("t229_events", boundary); err != nil {
		t.Fatalf("notify payload of 7999 bytes: %v", err)
	}
	got, err = sub.Receive()
	if err != nil || got.Payload != boundary {
		t.Fatalf("received 7999-byte payload: notification=%+v error=%v", got, err)
	}
	for _, payload := range []string{"buffer-1", "buffer-2", "buffer-3"} {
		if err := db.Notify("t229_events", payload); err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []string{"buffer-1", "buffer-2", "buffer-3"} {
		got, err = sub.Receive()
		if err != nil || got.Payload != want {
			t.Fatalf("buffered notification = %+v, %v; want %q", got, err, want)
		}
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
	noDeliveryCtx, noDeliveryCancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer noDeliveryCancel()
	noDelivery, err := db.WithContext(noDeliveryCtx).Listen("t229_unlisten_stops_delivery")
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, noDelivery)
	if err := noDelivery.Unlisten("t229_unlisten_stops_delivery"); err != nil {
		t.Fatal(err)
	}
	if err := db.Notify("t229_unlisten_stops_delivery", "must not arrive"); err != nil {
		t.Fatal(err)
	}
	if _, err := noDelivery.Receive(); orm.ErrorCode(err) != orm.CodeCanceled {
		t.Fatalf("receive after unlisten returned %v; want CANCELED without a notification", err)
	}
	if _, err := noDelivery.Receive(); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("receive after canceled subscription returned %v; want CONFIG", err)
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

	lostDSN := newDatabase(t, "postgres")
	lostDB, err := orm.Connect(lostDSN, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	lostSub, err := lostDB.Listen("t229_connection_lost")
	if err != nil {
		t.Fatal(err)
	}
	testcase.Close(t, lostDB)
	parsed, err := url.Parse(lostDSN)
	if err != nil {
		t.Fatal(err)
	}
	databaseName, err := url.PathUnescape(strings.TrimPrefix(parsed.Path, "/"))
	if err != nil {
		t.Fatal(err)
	}
	admin := openNative(t, "postgres", os.Getenv("ORM_TEST_POSTGRES_DSN"))
	defer testcase.Close(t, admin)
	var listenerPID int
	if err := admin.QueryRowContext(context.Background(),
		`SELECT pid FROM pg_stat_activity WHERE datname = $1 AND query = $2 AND pid <> pg_backend_pid()`,
		databaseName, `LISTEN "t229_connection_lost"`,
	).Scan(&listenerPID); err != nil {
		t.Fatal(err)
	}
	var terminated bool
	if err := admin.QueryRowContext(context.Background(), "SELECT pg_terminate_backend($1)", listenerPID).Scan(&terminated); err != nil || !terminated {
		t.Fatalf("terminate listener backend %d: terminated=%v error=%v", listenerPID, terminated, err)
	}
	if _, err := lostSub.Receive(); orm.ErrorCode(err) != orm.CodeConnectionLost {
		t.Fatalf("receive after listener connection loss returned %v; want CONNECTION_LOST", err)
	}
	if _, err := lostSub.Receive(); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("receive after connection loss returned %v; want CONFIG", err)
	}
	testcase.Close(t, lostSub)
}
