// Package pg registers the PostgreSQL driver with the executor. Import it for
// its side effect in a program that opens a "postgres" database:
//
//	import _ "github.com/polyspec/orm/packages/go/orm/pg"
//
// It is a separate package so a MySQL-only program does not link pgx.
package pg

import (
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/orm"
)

func init() { orm.RegisterDriver("postgres", "pgx", mapErr) }

// mapErr names the conditions that docs/spec/errors.yaml maps, and the executor
// reports the remaining driver errors as DRIVER.
func mapErr(err error) error {
	// is a connection that pgx has already closed. It is a lost-connection error, and its cause is marked
	// with driver.ErrBadConn so the transaction's rollback does not report a session the server ended as a failure.
	if errors.Is(err, pgconn.ErrConnClosed) {
		return &ir.Error{Code: orm.CodeConnectionLost, Msg: err.Error(), Cause: fmt.Errorf("%w: %w", driver.ErrBadConn, err)}
	}
	var pe *pgconn.PgError
	if !errors.As(err, &pe) {
		return err
	}
	// class 08 is connection exception. 57P01 (admin_shutdown), 57P02 (crash_shutdown),
	// and 57P05 (idle_session_timeout) are sent when the server ends a session.
	if strings.HasPrefix(pe.Code, "08") || pe.Code == "57P01" || pe.Code == "57P02" || pe.Code == "57P05" {
		return &ir.Error{Code: orm.CodeConnectionLost, Msg: pe.Error()}
	}
	switch pe.Code {
	case "55P03": // lock_not_available
		return &ir.Error{Code: orm.CodeLockNotAvailable, Msg: pe.Error()}
	case "40P01", "40001": // deadlock_detected, serialization_failure
		return &ir.Error{Code: orm.CodeDeadlock, Msg: pe.Error()}
	case "23505": // unique_violation
		return &ir.Error{Code: orm.CodeDuplicateKey, Msg: pe.Error()}
	case "23503": // foreign_key_violation
		return &ir.Error{Code: orm.CodeForeignKey, Msg: pe.Error()}
	case "23514": // check_violation
		return &ir.Error{Code: orm.CodeConstraint, Msg: pe.Error()}
	case "25006": // read_only_sql_transaction, including a write on a standby
		return &ir.Error{Code: orm.CodeReadOnly, Msg: pe.Error()}
	case "57014": // query_canceled, including statement_timeout
		return &ir.Error{Code: orm.CodeCanceled, Msg: pe.Error()}
	}
	return err
}
