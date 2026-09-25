// Package pg registers the PostgreSQL driver with the executor. Import it for
// its side effect in a program that opens a "postgres" database:
//
//	import _ "github.com/polyspec/orm/clients/go/orm/pg"
//
// It is a separate package so a MySQL-only program does not link pgx.
package pg

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine/ir"
)

func init() { orm.RegisterDriver("postgres", "pgx", mapErr) }

// mapErr names the two conditions docs/errors.yaml maps; everything else keeps
// the driver's own error.
func mapErr(err error) error {
	var pe *pgconn.PgError
	if !errors.As(err, &pe) {
		return err
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
