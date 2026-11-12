// Package markdowntest holds the listener helpers of the markdown test servers, which the markdown tests of the models and the
// bind message recipe share.
package markdowntest

import (
	"errors"
	"io"
	"net"
	"syscall"
	"testing"
)

// ServeMarkdownTestConnection serves the one connection that ln accepts, with serve, on a goroutine. The cleanup of t closes ln and
// reports the error of closing it and the error that serving ended with. Its errors are not reported from the goroutine,
// since a goroutine cannot end the test, and the cleanup waits for the goroutine, which ends when the client closes.
func ServeMarkdownTestConnection(t *testing.T, ln net.Listener, serve func(net.Conn) error) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- ClientEnded(err)
			return
		}
		err = serve(conn)
		if cerr := conn.Close(); cerr != nil && !errors.Is(cerr, net.ErrClosed) && err == nil {
			err = cerr
		}
		done <- err
	}()
	t.Cleanup(func() {
		if err := ln.Close(); err != nil {
			t.Errorf("close the listener: %v", err)
		}
		if err := <-done; err != nil {
			t.Errorf("serve the connection: %v", err)
		}
	})
}

// ClientEnded is the error of a read or write that ends because the client has gone away, which is the normal end of a
// served connection, and nil for it; any other error is returned.
func ClientEnded(err error) error {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) || errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) {
		return nil
	}
	return err
}

// ListenMarkdownTestServer listens on a free local TCP port; a failure fails the test.
func ListenMarkdownTestServer(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return ln
}
