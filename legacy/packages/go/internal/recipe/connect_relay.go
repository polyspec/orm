package recipe

import (
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"sync"
	"sync/atomic"
	"syscall"
)

// connectRelay is the TCP listener of catalog.reconnect {connects} (DIA-211): it listens on 127.0.0.1, relays each connection
// it accepts to the host and port of the DSN, copying the bytes both ways, and counts the connections it accepted. A client
// learns that its connect is refused only from bytes that the server sends through an accepted connection, so when a refused
// reconnect has returned, every connection that the client opened for it has been counted.
type connectRelay struct {
	listener net.Listener
	target   string
	accepted atomic.Int64
	mu       sync.Mutex
	conns    []net.Conn
	errs     []error
	done     sync.WaitGroup
}

// relayAuthority is the host and port of a DSN: scheme://user@host:port/...
var relayAuthority = regexp.MustCompile(`^([a-z]+://[^@/]+@)([^/?]+)(.*)$`)

// startConnectRelay starts a relay in front of the host and port of dsn and returns the DSN through it.
func startConnectRelay(dsn string) (*connectRelay, string, error) {
	match := relayAuthority.FindStringSubmatch(dsn)
	if match == nil {
		return nil, "", fmt.Errorf("catalog.reconnect connects: the DSN names no host and port: %s", dsn)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, "", err
	}
	r := &connectRelay{listener: listener, target: match[2]}
	r.done.Add(1)
	go r.serve()
	return r, match[1] + listener.Addr().String() + match[3], nil
}

func (r *connectRelay) serve() {
	defer r.done.Done()
	for {
		client, err := r.listener.Accept()
		if err != nil {
			return
		}
		r.accepted.Add(1)
		server, err := net.Dial("tcp", r.target)
		if err != nil {
			r.fail(fmt.Errorf("relay to %s: %w", r.target, err), r.end(client))
			continue
		}
		r.mu.Lock()
		r.conns = append(r.conns, client, server)
		r.mu.Unlock()
		r.done.Add(2)
		go r.copy(server, client)
		go r.copy(client, server)
	}
}

// copy copies one direction and closes both ends when it ends, which ends the other direction. A reset or a closed end is
// how a connection ends, not an error; any other error of the copy or of a close is an error of the relay.
func (r *connectRelay) copy(to, from net.Conn) {
	defer r.done.Done()
	_, err := io.Copy(to, from)
	if ended(err) {
		err = nil
	}
	r.fail(err, r.end(to), r.end(from))
}

// end closes conn; a connection that is already closed has ended.
func (r *connectRelay) end(conn net.Conn) error {
	if err := conn.Close(); !ended(err) {
		return err
	}
	return nil
}

// fail records the errors that are not nil, which close returns.
func (r *connectRelay) fail(errs ...error) {
	if err := errors.Join(errs...); err != nil {
		r.mu.Lock()
		r.errs = append(r.errs, err)
		r.mu.Unlock()
	}
}

// ended reports whether err is no error or the end of a connection: closed here, reset, aborted or a broken pipe.
func ended(err error) bool {
	return err == nil || errors.Is(err, net.ErrClosed) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNABORTED) ||
		errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ENOTCONN)
}

// close stops the relay, closes every relayed connection and returns when no goroutine of it runs.
func (r *connectRelay) close() error {
	err := r.listener.Close()
	r.mu.Lock()
	for _, conn := range r.conns {
		err = errors.Join(err, r.end(conn))
	}
	r.mu.Unlock()
	r.done.Wait()
	r.mu.Lock()
	defer r.mu.Unlock()
	return errors.Join(append([]error{err}, r.errs...)...)
}
