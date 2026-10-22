package orm

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/polyspec/orm/packages/go/engine/ir"
)

// Notification is one notification that a LISTEN subscription receives
// (docs/spec/dialects.md DIA-194): the channel, the payload, and the process id
// of the connection that sent it.
type Notification struct {
	Channel string
	Payload string
	PID     int32
}

// ListenConn is the connection of one LISTEN subscription: a connection of the
// driver that stands outside the pool. A driver package registers the function
// that opens it with RegisterListener.
type ListenConn interface {
	// Exec runs one statement without arguments.
	Exec(ctx context.Context, sqlText string) error
	// WaitNotification waits for the next notification, or until ctx is done.
	WaitNotification(ctx context.Context) (Notification, error)
	// Close ends the connection.
	Close() error
}

// listenOpeners holds the function that opens a LISTEN connection of each
// driver that supports LISTEN and NOTIFY.
var listenOpeners = map[string]func(ctx context.Context, native string) (ListenConn, error){}

// RegisterListener registers the function that opens a LISTEN connection of
// the driver name, from the native DSN. Driver packages call it from init.
func RegisterListener(name string, open func(ctx context.Context, native string) (ListenConn, error)) {
	driverMu.Lock()
	defer driverMu.Unlock()
	listenOpeners[name] = open
}

// Subscription is a LISTEN subscription (DIA-194 and DIA-195). It holds the
// connection of its own until Close, or until a receive is cancelled or expires.
type Subscription struct {
	mu       sync.Mutex
	conn     ListenConn
	ctx      context.Context
	channels map[string]bool
	closed   bool
}

// Notify sends payload to channel with pg_notify (DIA-193). Inside a
// Transaction the notification is delivered with the commit of that
// transaction; outside one, at the commit of its own statement. On MySQL,
// SQLite and the markdown executor it fails with CAPABILITY_UNSUPPORTED.
func (d *DB) Notify(channel, payload string) error {
	if err := d.listenable("notify"); err != nil {
		return err
	}
	if err := checkChannel(channel); err != nil {
		return err
	}
	var ex executor = d
	tx, err := activeFor(d)
	if err != nil {
		return err
	}
	if tx != nil {
		ex = tx
	}
	end, err := ex.enter()
	if err != nil {
		return err
	}
	defer end()
	st, err := ex.stmt(ex.context(), "SELECT pg_notify($1, $2)")
	if err != nil {
		return mapDriverErr(err)
	}
	if _, err := st.ExecContext(ex.context(), channel, payload); err != nil {
		return mapDriverErr(err)
	}
	return nil
}

// Listen opens a LISTEN subscription on channel (DIA-194). It uses a connection
// of its own, outside the pool, which the context of the handle cancels: a
// receive whose context is done fails with CANCELED and closes the
// subscription. On MySQL, SQLite and the markdown executor it fails with
// CAPABILITY_UNSUPPORTED.
func (d *DB) Listen(channel string) (*Subscription, error) {
	if err := d.listenable("listen"); err != nil {
		return nil, err
	}
	if err := checkChannel(channel); err != nil {
		return nil, err
	}
	open, ok := listenOpener(d.driver)
	if !ok {
		return nil, &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf("driver %q has no LISTEN connection", d.driver)}
	}
	ctx := d.context()
	conn, err := open(ctx, d.m.native)
	if err != nil {
		return nil, mapDriverErr(err)
	}
	if err := conn.Exec(ctx, "LISTEN "+quoteIdent(channel)); err != nil {
		err = mapDriverErr(err)
		if cerr := conn.Close(); cerr != nil {
			return nil, errors.Join(err, cerr)
		}
		return nil, err
	}
	return &Subscription{conn: conn, ctx: ctx, channels: map[string]bool{channel: true}}, nil
}

// Receive waits for the next notification of the subscription. A context that
// is done, or a closed subscription, fails the receive (CANCELED, or CONFIG for
// a closed subscription); a cancelled receive closes the subscription.
func (s *Subscription) Receive() (Notification, error) {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return Notification{}, &ir.Error{Code: CodeConfig, Msg: "the LISTEN subscription is closed"}
	}
	n, err := s.conn.WaitNotification(s.ctx)
	if err != nil {
		mapped := mapDriverErr(err)
		if ErrorCode(mapped) == CodeCanceled {
			_ = s.Close()
		}
		return Notification{}, mapped
	}
	return n, nil
}

// Unlisten stops delivery of channel on the subscription (DIA-195).
func (s *Subscription) Unlisten(channel string) error {
	if err := checkChannel(channel); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return &ir.Error{Code: CodeConfig, Msg: "the LISTEN subscription is closed"}
	}
	if !s.channels[channel] {
		return nil
	}
	if err := s.conn.Exec(context.Background(), "UNLISTEN "+quoteIdent(channel)); err != nil {
		return mapDriverErr(err)
	}
	delete(s.channels, channel)
	return nil
}

// Close runs UNLISTEN for every channel of the subscription and ends its
// connection (DIA-195). Closing a subscription twice does nothing.
func (s *Subscription) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	var errs []error
	if len(s.channels) > 0 {
		if err := s.conn.Exec(context.Background(), "UNLISTEN *"); err != nil {
			errs = append(errs, mapDriverErr(err))
		}
	}
	if err := s.conn.Close(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// listenable is the error of a LISTEN or NOTIFY surface on a database that has
// no such capability: a MySQL or SQLite connection, or a markdown connection.
func (d *DB) listenable(surface string) error {
	if d.driver == "postgres" {
		return nil
	}
	return &ir.Error{Code: CodeCapabilityUnsupported, Msg: surface + " is supported on PostgreSQL only"}
}

func listenOpener(name string) (func(ctx context.Context, native string) (ListenConn, error), bool) {
	driverMu.RLock()
	defer driverMu.RUnlock()
	open, ok := listenOpeners[name]
	return open, ok
}

// checkChannel accepts a channel of 1 to 63 bytes without U+0000 (DIA-192).
func checkChannel(channel string) error {
	if len(channel) < 1 || len(channel) > 63 || strings.ContainsRune(channel, 0) {
		return configErr("a channel is 1 to 63 bytes without U+0000")
	}
	return nil
}

// quoteIdent quotes a channel as a PostgreSQL identifier.
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
