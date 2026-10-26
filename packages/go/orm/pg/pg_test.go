package pg

import (
	"context"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

func TestOpenConnectorPingsEveryReusedConnection(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	connector, err := (configuredDriver{}).OpenConnector("postgres://orm@127.0.0.1/test")
	if err != nil {
		t.Fatal(err)
	}
	field := reflect.ValueOf(connector).FieldByName("ShouldPing")
	if !field.IsValid() || field.Kind() != reflect.Func {
		t.Fatal("pgx connector has no configured ShouldPing callback")
	}
	if got, want := field.Pointer(), reflect.ValueOf(pingReusedConnection).Pointer(); got != want {
		t.Fatalf("pgx ShouldPing callback = %x, want %x", got, want)
	}
	if !pingReusedConnection(context.Background(), stdlib.ShouldPingParams{}) {
		t.Fatal("PostgreSQL connection reuse must perform a liveness ping even for an immediately idle connection")
	}
}

func TestMapErrClassifiesCheckConstraint(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	err := mapErr(&pgconn.PgError{Code: "23514", Message: "check constraint violated"})
	if got := orm.ErrorCode(err); got != orm.CodeConstraint {
		t.Fatalf("mapped PostgreSQL check error code = %q, want %q: %v", got, orm.CodeConstraint, err)
	}
	if !orm.IsConstraint(err) {
		t.Fatal("mapped PostgreSQL check error is not recognized as a constraint")
	}
}

func TestMapErrClassifiesNowaitLock(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	err := mapErr(&pgconn.PgError{Code: "55P03", Message: "could not obtain lock"})
	if got := orm.ErrorCode(err); got != orm.CodeLockNotAvailable {
		t.Fatalf("mapped PostgreSQL lock error code = %q, want %q: %v", got, orm.CodeLockNotAvailable, err)
	}
	if !orm.IsLockNotAvailable(err) {
		t.Fatal("mapped PostgreSQL lock error is not recognized as lock unavailable")
	}
}

func TestMapErrClassifiesReadOnly(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	err := mapErr(&pgconn.PgError{Code: "25006", Message: "cannot execute INSERT in a read-only transaction"})
	if got := orm.ErrorCode(err); got != orm.CodeReadOnly {
		t.Fatalf("mapped PostgreSQL read-only error code = %q, want %q: %v", got, orm.CodeReadOnly, err)
	}
}
