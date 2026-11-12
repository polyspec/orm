package pg

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/polyspec/orm/packages/go/orm"
)

// LISTEN connections use pgx directly: the database/sql driver does not
// deliver notifications (docs/spec/dialects.md DIA-194).
func init() { orm.RegisterListener("postgres", openListen) }

// listenConn is a pgx connection of one LISTEN subscription.
type listenConn struct{ conn *pgx.Conn }

// openListen opens a connection of its own from the native DSN, outside any pool.
func openListen(ctx context.Context, native string) (orm.ListenConn, error) {
	cfg, err := pgx.ParseConfig(native)
	if err != nil {
		return nil, err
	}
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &listenConn{conn: conn}, nil
}

func (l *listenConn) Exec(ctx context.Context, sqlText string) error {
	_, err := l.conn.Exec(ctx, sqlText)
	return err
}

func (l *listenConn) WaitNotification(ctx context.Context) (orm.Notification, error) {
	n, err := l.conn.WaitForNotification(ctx)
	if err != nil {
		return orm.Notification{}, err
	}
	return orm.Notification{Channel: n.Channel, Payload: n.Payload, PID: int32(n.PID)}, nil
}

// Close ends the connection; it is bounded so that a server that does not answer
// cannot hold the caller.
func (l *listenConn) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return l.conn.Close(ctx)
}
