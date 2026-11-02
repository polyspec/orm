package markdownmodel_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"syscall"
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/markdownmodel"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeIRAnswersNone runs the read answer recipe, tests/ir/answers.json, without a database (FCV-3, FCV-4): each ir.answer
// step runs the chain of its case on a listener that answers with the case's answer. The chains come from conformanceCases, and
// the listener is served here, so the recipe package only compares the result (see Read in docs/spec/protocol.md §5).
// Requirements: PRT-69, PRT-71, PRT-72.
func TestRecipeIRAnswersNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	chains := conformanceCases()
	recipe.Run(t, "../../../tests/ir/answers.json", recipe.None, recipe.WithIRAnswer(func(t *testing.T, chain string, answer json.RawMessage, answers map[string]json.RawMessage) (any, error) {
		testcase.Start(t, testcase.Compute)
		run := chains[chain]
		if run == nil {
			t.Fatalf("chain %s is no markdown conformance case", chain)
		}
		dsn := ""
		if answers != nil {
			dsn = startMarkdownTestServerWithKeyedAnswers(t, answers)
		} else {
			// The fixture is pretty-printed, and the wire takes one message per line, so the answer is compacted.
			var compact bytes.Buffer
			if err := json.Compact(&compact, answer); err != nil {
				t.Fatalf("answer of chain %s: %v", chain, err)
			}
			dsn = startMarkdownTestServerWithAnswer(t, compact.String())
		}
		db, err := markdownmodel.Connect(dsn, orm.Config{PoolSize: 1})
		if err != nil {
			t.Fatal(err)
		}
		defer testcase.Close(t, db)
		return run(&served{db: db})
	}))
}

// startMarkdownTestServerWithAnswer is the DSN of a listener that writes {"ok": true} for the connect of one connection and, for the next message, the answer.
func startMarkdownTestServerWithAnswer(t *testing.T, answer string) string {
	t.Helper()
	ln := listenMarkdownTestServer(t)
	serveMarkdownTestConnection(t, ln, func(conn net.Conn) error {
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

// startMarkdownTestServerWithKeyedAnswers is the DSN of a listener that writes {"ok": true} for the connect of one connection and, for each following message, the answer found in answers by the op of that control message or by the
// kind of the request. A message with no answer gets IR_INVALID.
func startMarkdownTestServerWithKeyedAnswers(t *testing.T, answers map[string]json.RawMessage) string {
	t.Helper()
	ln := listenMarkdownTestServer(t)
	serveMarkdownTestConnection(t, ln, func(conn net.Conn) error {
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

// serveMarkdownTestConnection serves the one connection that ln accepts, with serve, on a goroutine. The cleanup of t closes ln and
// reports the error of closing it and the error that serving ended with. Its errors are not reported from the goroutine,
// since a goroutine cannot end the test, and the cleanup waits for the goroutine, which ends when the client closes.
func serveMarkdownTestConnection(t *testing.T, ln net.Listener, serve func(net.Conn) error) {
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

// listenMarkdownTestServer listens on a free local TCP port; a failure fails the test.
func listenMarkdownTestServer(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return ln
}
