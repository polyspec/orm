//go:build markdown

package markdownmodel_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
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
			defer db.Close()
			got, err := run(&served{db: db})
			if err != nil {
				code := orm.ErrorCode(err)
				if code == "" {
					t.Fatalf("%s failed without an orm code: %v", c.ID, err)
				}
				got = map[string]any{"error": code}
			}
			actual := normalize(t, got)
			if !reflect.DeepEqual(actual, c.Expect) {
				t.Fatalf("%s: got %s, want %s (error %v)", c.ID, jsonText(actual), jsonText(c.Expect), err)
			}
		})
	}
}

// answeringServer is the DSN of a listener that writes {"ok": true} for the connect of one connection and, for the next message, the answer.
// listener's DSN.
func answeringServer(t *testing.T, answer string) string {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		for _, line := range []string{`{"ok":true}`, answer} {
			if _, err := r.ReadString('\n'); err != nil {
				return
			}
			if _, err := conn.Write([]byte(line + "\n")); err != nil {
				return
			}
		}
		r.ReadString('\n')
	}()
	return "markdown://" + ln.Addr().String() + "/conformance?token=0123456789abcdef0123456789abcdef"
}

// keyedServer is the DSN of a listener that writes {"ok": true} for the connect of one connection and, for each following message, the answer found in answers by the op of that control message or by the
// kind of the request. A message with no answer gets IR_INVALID.
func keyedServer(t *testing.T, answers map[string]json.RawMessage) string {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		for first := true; ; first = false {
			line, err := r.ReadString('\n')
			if err != nil {
				return
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
				return
			}
		}
	}()
	return "markdown://" + ln.Addr().String() + "/conformance?token=0123456789abcdef0123456789abcdef"
}
