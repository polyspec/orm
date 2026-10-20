//go:build markdown

package markdownmodel_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/polyspec/orm/packages/go/markdownmodel"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestIRAnswers runs the chain of each case in contracts/fixtures/ir_answers.json: the server
// instead writes {"ok": true} for connect and the case's answer for one request of the chain, and connects to a listener
// and checks that the result of the chain equals expect (see Read in docs/spec/protocol.md §5). flowmark
// is not needed.
func TestIRAnswers(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", "ir_answers.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []struct {
			ID     string          `json:"id"`
			Chain  string          `json:"chain"`
			Answer json.RawMessage `json:"answer"`
			// Answers answers a transaction's messages by the op of a control message or the kind of a request.
			Answers map[string]json.RawMessage `json:"answers"`
			Expect  any                        `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("ir_answers.json: %v", err)
	}
	funcs := conformanceCases()
	for _, c := range doc.Cases {
		t.Run(c.ID, func(t *testing.T) {
			testcase.Start(t, testcase.Compute)
			run := funcs[c.Chain]
			if run == nil {
				t.Fatalf("chain %s is no markdown conformance case", c.Chain)
			}
			dsn := ""
			if c.Answers != nil {
				dsn = keyedServer(t, c.Answers)
			} else {
				dsn = answeringServer(t, string(c.Answer))
			}
			db, err := markdownmodel.Connect(dsn, orm.Config{PoolSize: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, db)
			got, err := run(&served{db: db})
			checkCaseResult(t, c.ID, got, err, c.Expect)
		})
	}
}

// answeringServer is the DSN of a listener that writes {"ok": true} for the connect of one connection and, for the next message, the answer.
// listener's DSN.
func answeringServer(t *testing.T, answer string) string {
	t.Helper()
	ln := listenLocal(t)
	serveListener(t, ln, func(conn net.Conn) error {
		r := bufio.NewReader(conn)
		for _, line := range []string{`{"ok":true}`, answer} {
			if _, err := r.ReadString('\n'); err != nil {
				return clientEnded(err)
			}
			if _, err := conn.Write([]byte(line + "\n")); err != nil {
				return clientEnded(err)
			}
		}
		_, err := r.ReadString('\n')
		return clientEnded(err)
	})
	return "markdown://" + ln.Addr().String() + "/conformance?token=0123456789abcdef0123456789abcdef"
}

// keyedServer is the DSN of a listener that writes {"ok": true} for the connect of one connection and, for each following message, the answer found in answers by the op of that control message or by the
// kind of the request. A message with no answer gets IR_INVALID.
func keyedServer(t *testing.T, answers map[string]json.RawMessage) string {
	t.Helper()
	ln := listenLocal(t)
	serveListener(t, ln, func(conn net.Conn) error {
		r := bufio.NewReader(conn)
		for first := true; ; first = false {
			line, err := r.ReadString('\n')
			if err != nil {
				return clientEnded(err)
			}
			reply := `{"ok":true}`
			if !first {
				var msg struct {
					Op      string `json:"op"`
					Request struct {
						Kind string `json:"kind"`
					} `json:"request"`
				}
				key := "unreadable"
				if json.Unmarshal([]byte(line), &msg) == nil {
					key = msg.Op
					if key == "" {
						key = msg.Request.Kind
					}
				}
				var compact bytes.Buffer
				if answer, ok := answers[key]; ok && json.Compact(&compact, answer) == nil {
					reply = compact.String()
				} else {
					reply = `{"error":{"code":"IR_INVALID","message":"the case has no answer for ` + key + `"}}`
				}
			}
			if _, err := conn.Write([]byte(reply + "\n")); err != nil {
				return clientEnded(err)
			}
		}
	})
	return "markdown://" + ln.Addr().String() + "/conformance?token=0123456789abcdef0123456789abcdef"
}

// serveListener serves the one connection that ln accepts, with serve, on a goroutine. The cleanup of t closes ln and
// reports the error of closing it and the error that serving ended with. Its errors are not reported from the goroutine,
// since a goroutine cannot end the test, and the cleanup waits for the goroutine, which ends when the client closes.
func serveListener(t *testing.T, ln net.Listener, serve func(net.Conn) error) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- clientEnded(err)
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

// clientEnded is the error of a read or write that ends because the client has gone away, which is the normal end of a
// served connection, and nil for it; any other error is returned.
func clientEnded(err error) error {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) || errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) {
		return nil
	}
	return err
}

// listenLocal listens on a free local TCP port; a failure fails the test.
func listenLocal(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return ln
}
