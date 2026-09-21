package pg

import (
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/polyspec/orm/clients/go/orm"
)

func TestMapErrClassifiesCheckConstraint(t *testing.T) {
	err := mapErr(&pgconn.PgError{Code: "23514", Message: "check constraint violated"})
	if got := orm.ErrorCode(err); got != orm.CodeConstraint {
		t.Fatalf("mapped PostgreSQL check error code = %q, want %q: %v", got, orm.CodeConstraint, err)
	}
	if !orm.IsConstraint(err) {
		t.Fatal("mapped PostgreSQL check error is not recognized as a constraint")
	}
}

func TestMapErrClassifiesNowaitLock(t *testing.T) {
	err := mapErr(&pgconn.PgError{Code: "55P03", Message: "could not obtain lock"})
	if got := orm.ErrorCode(err); got != orm.CodeLockNotAvailable {
		t.Fatalf("mapped PostgreSQL lock error code = %q, want %q: %v", got, orm.CodeLockNotAvailable, err)
	}
	if !orm.IsLockNotAvailable(err) {
		t.Fatal("mapped PostgreSQL lock error is not recognized as lock unavailable")
	}
}
