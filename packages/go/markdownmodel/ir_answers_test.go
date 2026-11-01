//go:build markdown

package markdownmodel_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"testing"

	"github.com/polyspec/orm/packages/go/internal/markdowntest"
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

// listenMarkdownTestServer and serveMarkdownTestConnection are the names that every markdown test server of the client owners
// uses (KSTD-2-11, scripts/features/manifest.test.mts); they are the helpers of markdowntest.
var (
	listenMarkdownTestServer    = markdowntest.ListenMarkdownTestServer
	serveMarkdownTestConnection = markdowntest.ServeMarkdownTestConnection
)

// startMarkdownTestServerWithAnswer is the DSN of a listener that writes {"ok": true} for the connect of one connection and, for the next message, the answer.
func startMarkdownTestServerWithAnswer(t *testing.T, answer string) string {
	t.Helper()
	ln := listenMarkdownTestServer(t)
	serveMarkdownTestConnection(t, ln, func(conn net.Conn) error {
		r := bufio.NewReader(conn)
		for _, line := range []string{`{"ok":true}`, answer} {
			if _, err := r.ReadString('\n'); err != nil {
				return markdowntest.ClientEnded(err)
			}
			if _, err := conn.Write([]byte(line + "\n")); err != nil {
				return markdowntest.ClientEnded(err)
			}
		}
		_, err := r.ReadString('\n')
		return markdowntest.ClientEnded(err)
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
				return markdowntest.ClientEnded(err)
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
				return markdowntest.ClientEnded(err)
			}
		}
	})
	return "markdown://" + ln.Addr().String() + "/conformance?token=0123456789abcdef0123456789abcdef"
}
