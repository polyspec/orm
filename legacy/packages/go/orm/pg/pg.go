// Package pg registers the PostgreSQL driver with the executor. Import it for
// its side effect in a program that opens a "postgres" database:
//
//	import _ "github.com/polyspec/orm/legacy/packages/go/orm/pg"
//
// It is a separate package so a MySQL-only program does not link pgx.
package pg

import (
	"context"
	"crypto/tls"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgconn/ctxwatch"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/polyspec/orm/legacy/packages/go/engine/ir"
	"github.com/polyspec/orm/legacy/packages/go/orm"
)

func init() {
	sql.Register("polyspec-pgx", configuredDriver{})
	orm.RegisterDriver("postgres", "polyspec-pgx", mapErr)
	orm.RegisterDeallocator("postgres", func(ctx context.Context, driverConn any) error {
		conn, ok := driverConn.(*stdlib.Conn)
		if !ok {
			return fmt.Errorf("the postgres deallocator received a connection of type %T", driverConn)
		}
		return conn.Conn().DeallocateAll(ctx)
	})
}

type configuredDriver struct{}

func (configuredDriver) Open(name string) (driver.Conn, error) {
	connector, err := (configuredDriver{}).OpenConnector(name)
	if err != nil {
		return nil, err
	}
	return connector.Connect(context.Background())
}

func (configuredDriver) OpenConnector(name string) (driver.Connector, error) {
	config, err := pgx.ParseConfig(name)
	if err != nil {
		return nil, err
	}
	config.BuildContextWatcherHandler = func(conn *pgconn.PgConn) ctxwatch.Handler {
		return &pgconn.CancelRequestContextWatcherHandler{
			Conn:               conn,
			CancelRequestDelay: 0,
			// pgx's own CancelRequest handler tests use 5s, allowing its
			// protocol cancel to arrive before the connection deadline fallback.
			DeadlineDelay: 5 * time.Second,
		}
	}
	// Before each reuse of a connection the pool checks that the server still holds it, at any idle time: a statement that
	// reached a connection that the server had ended would fail (INT-92). The check is a protocol Sync and its
	// ReadyForQuery, as sqlx does, and not the "-- ping" query of pgx, which the server runs as a transaction of its own
	// and so counts against the transactions of each statement (INT-149). The driver's own ping, which it sends after one
	// second of idle time, is turned off, since the check runs every time.
	return stdlib.GetConnector(*config,
		stdlib.OptionShouldPing(func(context.Context, stdlib.ShouldPingParams) bool { return false }),
		stdlib.OptionResetSession(syncCheck)), nil
}

// syncCheck sends a Sync and reads to its ReadyForQuery through a pipeline of pgconn, which holds the lock of the
// connection from StartPipeline to Close and reads every message to the ReadyForQuery that the Sync asks for. An ended
// connection answers with its FATAL error or the end of the stream, and the connection is then reported as bad, so
// database/sql discards it and opens a new one.
func syncCheck(ctx context.Context, conn *pgx.Conn) error {
	pipeline := conn.PgConn().StartPipeline(ctx)
	syncErr := pipeline.Sync()
	if err := errors.Join(syncErr, pipeline.Close()); err != nil {
		return driver.ErrBadConn
	}
	return nil
}

// mapErr names the conditions that docs/spec/errors.yaml maps, and the executor
// reports the remaining driver errors as DRIVER.
func mapErr(err error) error {
	// is a connection that pgx has already closed. It is a lost-connection error, and its cause is marked
	// with driver.ErrBadConn so the transaction's rollback does not report a session the server ended as a failure.
	if errors.Is(err, pgconn.ErrConnClosed) {
		return &ir.Error{Code: orm.CodeConnectionLost, Msg: err.Error(), Cause: fmt.Errorf("%w: %w", driver.ErrBadConn, err)}
	}
	// A certificate that the CA or the host of sslmode=verify-full refuses is CONFIG (CFG-45).
	var refused *tls.CertificateVerificationError
	if errors.As(err, &refused) {
		return &ir.Error{Code: orm.CodeConfig, Msg: "postgres TLS connection failed: " + err.Error(), Cause: err}
	}
	var pe *pgconn.PgError
	if !errors.As(err, &pe) {
		return err
	}
	// class 08 is connection exception. 57P01 (admin_shutdown), 57P02 (crash_shutdown),
	// 57P05 (idle_session_timeout) and 25P03 (idle_in_transaction_session_timeout) are sent when the server ends a session.
	if strings.HasPrefix(pe.Code, "08") || pe.Code == "25P03" || pe.Code == "57P01" || pe.Code == "57P02" || pe.Code == "57P05" {
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
