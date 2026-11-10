package recipe

import (
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"sync"
	"sync/atomic"
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
			_ = client.Close()
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

// copy copies one direction and closes both ends when it ends, which ends the other direction.
func (r *connectRelay) copy(to, from net.Conn) {
	defer r.done.Done()
	_, _ = io.Copy(to, from)
	_ = to.Close()
	_ = from.Close()
}

// close stops the relay, closes every relayed connection and returns when no goroutine of it runs.
func (r *connectRelay) close() error {
	err := r.listener.Close()
	r.mu.Lock()
	for _, conn := range r.conns {
		if closeErr := conn.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			err = errors.Join(err, closeErr)
		}
	}
	r.mu.Unlock()
	r.done.Wait()
	return err
}
