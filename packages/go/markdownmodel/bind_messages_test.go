//go:build markdown

package markdownmodel_test

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/bindmodel"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeBindMessagesNone runs the markdown message and control recipe, tests/bind/messages.json, without a database (FCV-3,
// FCV-4): each markdown.send step runs one typed public call on a listener that records the first message it receives.
// Requirements: PRT-67.
func TestRecipeBindMessagesNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/bind/messages.json", recipe.None, recipe.WithMarkdownSend(markdownSend))
}

// markdownSend runs one markdown.send step. It returns the first message that the listener receives, the message of a begin or
// the parameter of a statement, or the code of the error that the call returns before it sends a message. A non-empty processZone
// is the process default zone for the step, restored afterward.
func markdownSend(t *testing.T, column, operator string, params []json.RawMessage, begin *bool, processZone string) (json.RawMessage, string) {
	t.Helper()
	testcase.Start(t, testcase.Compute)
	if processZone != "" {
		loc, err := time.LoadLocation(processZone)
		if err != nil {
			t.Fatalf("load the process zone %s: %v", processZone, err)
		}
		prev := time.Local
		time.Local = loc
		defer func() { time.Local = prev }()
	}
	first := make(chan json.RawMessage, 1)
	dsn := startMarkdownSendListener(t, first)
	db, err := bindmodel.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var callErr error
	if begin != nil {
		var opts []orm.TransactionOption
		if *begin {
			opts = append(opts, orm.ReadOnly())
		}
		callErr = db.Transaction(func() error { return nil }, opts...)
	} else {
		if operator != "eq" {
			t.Fatalf("operator %s has no typed filter in the Go cases", operator)
		}
		callErr = queryColumn(t, db, column, params[0])
	}
	select {
	case msg := <-first:
		return messageValue(t, msg), ""
	default:
	}
	var e *ir.Error
	if errors.As(callErr, &e) {
		return nil, e.Code
	}
	t.Fatalf("the call returned %v and sent no message", callErr)
	return nil, ""
}

// messageValue is the message that an expect compares: the whole message of a begin, or the first parameter of a statement.
func messageValue(t *testing.T, msg json.RawMessage) json.RawMessage {
	t.Helper()
	var m struct {
		Op     string            `json:"op"`
		Params []json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(msg, &m); err != nil {
		t.Fatalf("the message %s is not JSON: %v", msg, err)
	}
	if m.Op == "begin" {
		return msg
	}
	if len(m.Params) != 1 {
		t.Fatalf("the statement message %s holds %d parameters, want one", msg, len(m.Params))
	}
	return m.Params[0]
}

// queryColumn reads the slot column through its typed filter with the host value of the wrapper. The declared type of the
// column decides the filter: the typed filter of each slot takes the text of its wrapper (DBS-121).
func queryColumn(t *testing.T, db *orm.DB, column string, value json.RawMessage) error {
	t.Helper()
	switch column {
	case "slots.time0_value":
		_, err := bindmodel.Slots().Connect(db).GetsByTime0Value(text(t, value))
		return err
	case "slots.time3_value":
		_, err := bindmodel.Slots().Connect(db).GetsByTime3Value(text(t, value))
		return err
	case "slots.time6_value":
		_, err := bindmodel.Slots().Connect(db).GetsByTime6Value(text(t, value))
		return err
	case "slots.datetime0_value":
		_, err := bindmodel.Slots().Connect(db).GetsByDatetime0Value(text(t, value))
		return err
	case "slots.datetime3_value":
		_, err := bindmodel.Slots().Connect(db).GetsByDatetime3Value(text(t, value))
		return err
	case "slots.datetime6_value":
		_, err := bindmodel.Slots().Connect(db).GetsByDatetime6Value(text(t, value))
		return err
	case "slots.date_value":
		_, err := bindmodel.Slots().Connect(db).GetsByDateValue(text(t, value))
		return err
	}
	t.Fatalf("the column %s has no typed filter in the Go cases", column)
	return nil
}

// text is the text of a wrapper of a string host type.
func text(t *testing.T, value json.RawMessage) string {
	t.Helper()
	var w map[string]string
	if err := json.Unmarshal(value, &w); err != nil || len(w) != 1 {
		t.Fatalf("the parameter %s is no text wrapper", value)
	}
	for _, v := range w {
		return v
	}
	return ""
}

// startMarkdownSendListener serves the one connection of a markdown.send step: it answers connect with {"ok": true}, sends the first
// message after it to first, and answers that message with an error so the call ends. Later messages get the same error.
func startMarkdownSendListener(t *testing.T, first chan<- json.RawMessage) string {
	t.Helper()
	ln := listenMarkdownTestServer(t)
	serveMarkdownTestConnection(t, ln, func(conn net.Conn) error {
		r := bufio.NewReader(conn)
		for index := 0; ; index++ {
			line, err := r.ReadString('\n')
			if err != nil {
				return clientEnded(err)
			}
			reply := `{"ok":true}`
			if index > 0 {
				if index == 1 {
					first <- json.RawMessage(line)
				}
				reply = `{"error":{"code":"IR_INVALID","message":"recorded by the markdown.send listener"}}`
			}
			if _, err := conn.Write([]byte(reply + "\n")); err != nil {
				return clientEnded(err)
			}
		}
	})
	return fmt.Sprintf("markdown://%s/conformance?token=0123456789abcdef0123456789abcdef", ln.Addr().String())
}
