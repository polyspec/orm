// Package pg registers the PostgreSQL driver with the executor. Import it for
// its side effect in a program that opens a "postgres" database:
//
//	import _ "github.com/polyspec/orm/clients/go/orm/pg"
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

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine/ir"
)

func init() { orm.RegisterDriver("postgres", "pgx", mapErr) }

// mapErr는 docs/errors.yaml이 mapping하는 조건에 이름을 붙이고, executor는
// 나머지 driver 오류를 DRIVER로 보고한다.
func mapErr(err error) error {
	// pgx가 이미 닫은 connection이다. 연결을 잃은 오류이며 cause는 driver.ErrBadConn으로
	// 표시해 transaction의 rollback이 server가 끝낸 session을 실패로 보고하지 않게 한다.
	if errors.Is(err, pgconn.ErrConnClosed) {
		return &ir.Error{Code: orm.CodeConnectionLost, Msg: err.Error(), Cause: fmt.Errorf("%w: %w", driver.ErrBadConn, err)}
	}
	var pe *pgconn.PgError
	if !errors.As(err, &pe) {
		return err
	}
	// class 08은 connection exception이다. 57P01(admin_shutdown), 57P02(crash_shutdown),
	// 57P05(idle_session_timeout)는 server가 session을 끝낼 때 보낸다.
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
