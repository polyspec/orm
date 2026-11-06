package bindmessages_test

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/bindmodel"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/internal/markdowntest"
	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeBindMessagesNone runs the markdown message and control recipe, tests/bind/messages.json, without a database (FCV-3,
// FCV-4): each markdown.send step runs one typed public call on a listener that records the first message it receives.
// Requirements: PRT-67.
func TestRecipeBindMessagesNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/bind/messages.json", recipe.None, recipe.WithMarkdownSend(markdownSend), recipe.WithModelAssign(modelAssign))
}

// TestRecipeBindMessagesRawTextNone runs the cases of a text that is not UTF-8, tests/bind/messages-raw-text.json, without a
// database (FCV-3, FCV-4): a Go string holds any bytes, so the text_hex wrapper is its host value.
// Requirements: PRT-67.
func TestRecipeBindMessagesRawTextNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/bind/messages-raw-text.json", recipe.None, recipe.WithMarkdownSend(markdownSend))
}

// TestRecipePublicInterfaceNone runs the public interface recipe, contracts/fixtures/public_interface/public_interface.json,
// without a database (FCV-3, FCV-4).
// Requirements: INT-17, INT-18, INT-19, INT-57, INT-61, INT-64, INT-74, INT-88, INT-89, INT-130.
func TestRecipePublicInterfaceNone(t *testing.T) {
	testcase.Start(t, testcase.Process)
	recipe.Run(t, "../../../contracts/fixtures/public_interface/public_interface.json", recipe.None, recipe.WithMarkdownBuilder(markdownBuilder))
}

// markdownBuilder runs one markdown.builder step: the builder calls on the slots model, then GetCount, on a connection to the
// listener of sendFirst. A message that reaches the listener fails the test, since the terminal returns the error before it.
func markdownBuilder(t *testing.T, calls []string) (string, string) {
	t.Helper()
	testcase.Start(t, testcase.Compute)
	first := make(chan json.RawMessage, 1)
	db := connectSendListener(t, first)
	model := bindmodel.Slots().Connect(db)
	for _, call := range calls {
		switch call {
		case "limit_zero_count":
			model = model.Limit(0, 0)
		case "empty_i64_list":
			model = model.I64Value([]int64{})
		case "empty_varchar_list":
			model = model.VarcharValue([]string{})
		default:
			t.Fatalf("markdown.builder call %s has no builder call in the Go cases", call)
		}
	}
	_, callErr := model.GetCount()
	select {
	case msg := <-first:
		t.Fatalf("the terminal sent %s before its error", msg)
	default:
	}
	var e *ir.Error
	if !errors.As(callErr, &e) {
		t.Fatalf("the terminal returned %v, want an orm error", callErr)
	}
	return e.Code, e.Error()
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
	return sendFirst(t, begin != nil, func(db *orm.DB) error {
		if begin != nil {
			var opts []orm.TransactionOption
			if *begin {
				opts = append(opts, orm.ReadOnly())
			}
			return db.Transaction(func() error { return nil }, opts...)
		}
		switch operator {
		case "eq":
			return queryColumn(t, db, column, params[0])
		case "like_contains":
			return likeColumn(t, db, column, params[0])
		case "eq_method", "ne_method", "gt_method":
			return operatorChain(t, db, operator, column, params[0])
		default:
			t.Fatalf("operator %s has no typed filter in the Go cases", operator)
		}
		return nil
	})
}

// modelAssign runs one model.assign step: the public setter of the column of a new row of the model, then its insert, which
// the listener of sendFirst records. The setter takes the host value of the wrapper, so a nil wrapper is not reached here: the
// typed setter takes no null, and the case excludes go.
func modelAssign(t *testing.T, model, column string, value json.RawMessage) (json.RawMessage, string) {
	t.Helper()
	testcase.Start(t, testcase.Compute)
	if model != "slots" || column != "varchar_value" {
		t.Fatalf("model.assign of %s.%s has no typed setter in the Go cases", model, column)
	}
	return sendFirst(t, false, func(db *orm.DB) error {
		_, err := bindmodel.Slots().Connect(db).SetVarcharValue(text(t, value)).Create()
		return err
	})
}

// connectSendListener connects to a new listener that records the first message after connect in first; the connection
// closes with the test.
func connectSendListener(t *testing.T, first chan<- json.RawMessage) *orm.DB {
	t.Helper()
	db, err := bindmodel.Connect(startMarkdownSendListener(t, first), orm.Config{})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	return db
}

// sendFirst runs call on a connection to a listener that answers connect and records the first message after it, and returns
// that message's value, or the code of the orm error that call returns before it sends a message. A whole step returns the
// whole message, as the statement that begins a transaction is compared.
func sendFirst(t *testing.T, whole bool, call func(db *orm.DB) error) (json.RawMessage, string) {
	t.Helper()
	first := make(chan json.RawMessage, 1)
	db := connectSendListener(t, first)
	callErr := call(db)
	select {
	case msg := <-first:
		if whole {
			return msg, ""
		}
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

// messageValue is the message that an expect compares: the first parameter of a statement.
func messageValue(t *testing.T, msg json.RawMessage) json.RawMessage {
	t.Helper()
	var m struct {
		Params []json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(msg, &m); err != nil {
		t.Fatalf("the message %s is not JSON: %v", msg, err)
	}
	// A statement with no parameter (a nil compared with eq is IS NULL, DSL-48) has the empty list as its message.
	if len(m.Params) == 0 {
		return json.RawMessage("[]")
	}
	if len(m.Params) == 1 {
		return m.Params[0]
	}
	// A list of several parameters (a list condition, DSL-50) is compared as the list.
	list, err := json.Marshal(m.Params)
	if err != nil {
		t.Fatalf("the parameters of %s: %v", msg, err)
	}
	return list
}

// operatorChain runs the chain method of an operator on the integer column of the DSL-50 cases, with the value or the list of its
// wrapper. A use that the method types refuse is no case of the Go binding: the compiler refuses it (TestChainArgumentTypes).
func operatorChain(t *testing.T, db *orm.DB, operator, column string, value json.RawMessage) error {
	t.Helper()
	if column != "slots.i64_value" {
		t.Fatalf("the column %s has no operator chain in the Go cases", column)
	}
	list, isList := integerList(t, value)
	switch {
	case operator == "eq_method" && isList:
		_, err := bindmodel.Slots().Connect(db).EqI64Value(list).Gets()
		return err
	case operator == "ne_method" && isList:
		_, err := bindmodel.Slots().Connect(db).NeI64Value(list).Gets()
		return err
	case operator == "gt_method" && !isList:
		_, err := bindmodel.Slots().Connect(db).GtI64Value(integer[int64](t, value, 64)).Gets()
		return err
	}
	t.Fatalf("the operator %s has no typed chain for %s in the Go cases", operator, value)
	return nil
}

// integerList is the list of an array wrapper of int wrappers, and false for any other wrapper.
func integerList(t *testing.T, value json.RawMessage) ([]int64, bool) {
	t.Helper()
	var w struct {
		Array []json.RawMessage `json:"array"`
	}
	if err := json.Unmarshal(value, &w); err != nil || w.Array == nil {
		return nil, false
	}
	list := make([]int64, 0, len(w.Array))
	for _, item := range w.Array {
		list = append(list, integer[int64](t, item, 64))
	}
	return list, true
}

// queryColumn reads the slot column through its typed filter with the host value of the wrapper. The declared type of the
// column decides the filter: the typed filter of each slot takes the text of its wrapper (DBS-121).
func queryColumn(t *testing.T, db *orm.DB, column string, value json.RawMessage) error {
	t.Helper()
	if list, ok := integerList(t, value); ok {
		if column != "slots.i64_value" {
			t.Fatalf("the column %s has no list filter in the Go cases", column)
		}
		_, err := bindmodel.Slots().Connect(db).I64Value(list).Gets()
		return err
	}
	switch column {
	case "slots.time0_value":
		_, err := bindmodel.Slots().Connect(db).GetsByTime0Value(text(t, value))
		return err
	case "slots.time1_value":
		_, err := bindmodel.Slots().Connect(db).Time1Value(text(t, value)).Gets()
		return err
	case "slots.time2_value":
		_, err := bindmodel.Slots().Connect(db).Time2Value(text(t, value)).Gets()
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
	case "slots.datetime1_value":
		_, err := bindmodel.Slots().Connect(db).Datetime1Value(text(t, value)).Gets()
		return err
	case "slots.datetime2_value":
		_, err := bindmodel.Slots().Connect(db).Datetime2Value(text(t, value)).Gets()
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
	case "slots.decimal_value":
		_, err := bindmodel.Slots().Connect(db).DecimalValue(text(t, value)).Gets()
		return err
	case "slots.varchar_value":
		_, err := bindmodel.Slots().Connect(db).VarcharValue(text(t, value)).Gets()
		return err
	case "slots.varchar_null_value":
		if isNil(value) {
			_, err := bindmodel.Slots().Connect(db).VarcharNullValue(orm.Null).Gets()
			return err
		}
		_, err := bindmodel.Slots().Connect(db).VarcharNullValue(text(t, value)).Gets()
		return err
	case "slots.varchar_long_value":
		_, err := bindmodel.Slots().Connect(db).VarcharLongValue(text(t, value)).Gets()
		return err
	case "slots.text_value":
		_, err := bindmodel.Slots().Connect(db).TextValue(text(t, value)).Gets()
		return err
	case "slots.bytes_value":
		_, err := bindmodel.Slots().Connect(db).BytesValue(bytesHex(t, value)).Gets()
		return err
	case "slots.uuid_value":
		_, err := bindmodel.Slots().Connect(db).UuidValue(text(t, value)).Gets()
		return err
	case "slots.i16_value":
		_, err := bindmodel.Slots().Connect(db).I16Value(integer[int16](t, value, 16)).Gets()
		return err
	case "slots.i32_value":
		_, err := bindmodel.Slots().Connect(db).I32Value(integer[int32](t, value, 32)).Gets()
		return err
	case "slots.i64_value":
		_, err := bindmodel.Slots().Connect(db).I64Value(integer[int64](t, value, 64)).Gets()
		return err
	case "slots.f64_value":
		_, err := bindmodel.Slots().Connect(db).F64Value(float(t, value)).Gets()
		return err
	case "slots.bool_value":
		_, err := bindmodel.Slots().Connect(db).BoolValue(boolean(t, value)).Gets()
		return err
	}
	t.Fatalf("the column %s has no typed filter in the Go cases", column)
	return nil
}

// likeColumn runs the contains condition of the slot column with the host value of the wrapper: the generated Lk method of the
// column, which the markdown transform of the planner turns into the pattern that contains the text (PRT-67). The typed Lk method
// takes no null, so a nil wrapper is excluded from the Go cases (bind_contains_null).
func likeColumn(t *testing.T, db *orm.DB, column string, value json.RawMessage) error {
	t.Helper()
	switch column {
	case "slots.text_value":
		_, err := bindmodel.Slots().Connect(db).LkTextValue(text(t, value)).Gets()
		return err
	}
	t.Fatalf("the column %s has no contains filter in the Go cases", column)
	return nil
}

// text is the text of a wrapper of a string host type; a text_hex wrapper is the string of its bytes, which need not be UTF-8.
func text(t *testing.T, value json.RawMessage) string {
	t.Helper()
	var w map[string]string
	if err := json.Unmarshal(value, &w); err != nil || len(w) != 1 {
		t.Fatalf("the parameter %s is no text wrapper", value)
	}
	if h, ok := w["text_hex"]; ok {
		b, err := hex.DecodeString(h)
		if err != nil {
			t.Fatalf("the parameter %s holds no hex: %v", value, err)
		}
		return string(b)
	}
	for _, v := range w {
		return v
	}
	return ""
}

// isNil reports whether the parameter is the nil wrapper, the SQL NULL of a nullable column.
func isNil(value json.RawMessage) bool {
	var w map[string]json.RawMessage
	if err := json.Unmarshal(value, &w); err != nil {
		return false
	}
	_, ok := w["nil"]
	return ok
}

// bytesHex is the host value of a bytes_hex wrapper.
func bytesHex(t *testing.T, value json.RawMessage) []byte {
	t.Helper()
	var w map[string]string
	if err := json.Unmarshal(value, &w); err != nil || len(w) != 1 {
		t.Fatalf("the parameter %s is no bytes_hex wrapper", value)
	}
	b, err := hex.DecodeString(w["bytes_hex"])
	if err != nil {
		t.Fatalf("the parameter %s holds no hex: %v", value, err)
	}
	return b
}

// integer is the host value of an int wrapper for a host type of the given bit size. A text that the host type cannot hold
// is a failure here: the recipe excludes such cases for go, because the typed API refuses them at compile time.
func integer[T int16 | int32 | int64](t *testing.T, value json.RawMessage, bits int) T {
	t.Helper()
	var w map[string]string
	if err := json.Unmarshal(value, &w); err != nil || len(w) != 1 {
		t.Fatalf("the parameter %s is no int wrapper", value)
	}
	s, ok := w["int"]
	if !ok {
		t.Fatalf("the parameter %s is no int wrapper", value)
	}
	n, err := strconv.ParseInt(s, 10, bits)
	if err != nil {
		t.Fatalf("the parameter %s is outside the host type: %v", value, err)
	}
	return T(n)
}

// wrapper is the key and the raw value of a one-key wrapper of a typed parameter, such as {"float": "1.5"}.
func wrapper(t *testing.T, value json.RawMessage) (string, json.RawMessage) {
	t.Helper()
	var w map[string]json.RawMessage
	if err := json.Unmarshal(value, &w); err != nil || len(w) != 1 {
		t.Fatalf("the parameter %s is no one-key wrapper", value)
	}
	for k, v := range w {
		return k, v
	}
	return "", nil
}

// float is the host value of a float, int or f64 wrapper for the float64 host type. The text of a float or int wrapper is
// parsed as a decimal number, an integer being a valid float; the f64 wrapper names NaN and the infinities. A text that does
// not parse fails the test.
func float(t *testing.T, value json.RawMessage) float64 {
	t.Helper()
	key, raw := wrapper(t, value)
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("the parameter %s holds no text: %v", value, err)
	}
	switch key {
	case "float", "int":
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			t.Fatalf("the parameter %s is no float: %v", value, err)
		}
		return f
	case "f64":
		switch s {
		case "NaN":
			return math.NaN()
		case "Infinity":
			return math.Inf(1)
		case "-Infinity":
			return math.Inf(-1)
		}
		t.Fatalf("the parameter %s names no f64 value", value)
	}
	t.Fatalf("the parameter %s is no float wrapper", value)
	return 0
}

// boolean is the host value of a bool wrapper.
func boolean(t *testing.T, value json.RawMessage) bool {
	t.Helper()
	key, raw := wrapper(t, value)
	var b bool
	if key != "bool" || json.Unmarshal(raw, &b) != nil {
		t.Fatalf("the parameter %s is no bool wrapper", value)
	}
	return b
}

// startMarkdownSendListener serves the one connection of a markdown.send step: it answers connect with {"ok": true}, sends the first
// message after it to first, and answers that message with an error so the call ends. Later messages get the same error.
func startMarkdownSendListener(t *testing.T, first chan<- json.RawMessage) string {
	t.Helper()
	ln := markdowntest.ListenMarkdownTestServer(t)
	markdowntest.ServeMarkdownTestConnection(t, ln, func(conn net.Conn) error {
		r := bufio.NewReader(conn)
		recorded := false
		for index := 0; ; index++ {
			line, err := r.ReadString('\n')
			if err != nil {
				return markdowntest.ClientEnded(err)
			}
			reply := `{"ok":true}`
			if index > 0 {
				// The setup statements of orm's SQLite dialect, such as the row lock table that a transaction needs, are
				// answered as done; the first message of the call is recorded, and every later one is refused.
				var m struct {
					Op  string `json:"op"`
					SQL string `json:"sql"`
				}
				if err := json.Unmarshal([]byte(line), &m); err != nil {
					return err
				}
				setup := m.Op == "statement" && strings.HasPrefix(m.SQL, `CREATE TABLE IF NOT EXISTS "orm__`)
				switch {
				case setup:
					reply = `{"columns":[],"rows":[],"affected":0,"last_insert_id":0}`
				case !recorded:
					recorded = true
					first <- json.RawMessage(line)
					reply = `{"error":{"code":"IR_INVALID","message":"recorded by the markdown.send listener"}}`
				default:
					reply = `{"error":{"code":"IR_INVALID","message":"recorded by the markdown.send listener"}}`
				}
			}
			if _, err := conn.Write([]byte(reply + "\n")); err != nil {
				return markdowntest.ClientEnded(err)
			}
		}
	})
	return fmt.Sprintf("markdown://%s/conformance?token=0123456789abcdef0123456789abcdef", ln.Addr().String())
}
