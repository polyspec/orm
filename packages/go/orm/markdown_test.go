package orm

import (
	"bufio"
	"errors"
	"net"
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

func TestParseMarkdownDSN(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	got, err := parseDSN("markdown://127.0.0.1:4100/tracker?token=0123456789abcdef0123456789abcdef", 0)
	if err != nil {
		t.Fatal(err)
	}
	want := markdownDSN{address: "127.0.0.1:4100", corpus: "tracker", token: "0123456789abcdef0123456789abcdef"}
	if got.driver != "markdown" || got.markdown != want || got.location.String() != "UTC" {
		t.Fatalf("parseDSN() = %+v; want driver markdown and %+v", got, want)
	}
	for _, input := range []string{
		"markdown://127.0.0.1:4100/tracker",
		"markdown://127.0.0.1:4100/tracker?token=",
		"markdown://127.0.0.1:4100/tracker?token=a&token=b",
		"markdown://127.0.0.1:4100/tracker?token=a&mode=ro",
		"markdown://127.0.0.1/tracker?token=a",
		"markdown://127.0.0.1:0/tracker?token=a",
		"markdown://127.0.0.1:port/tracker?token=a",
		"markdown://localhost:4100/tracker?token=a",
		"markdown://10.0.0.1:4100/tracker?token=a",
		"markdown://user@127.0.0.1:4100/tracker?token=a",
		"markdown://127.0.0.1:4100/?token=a",
		"markdown://127.0.0.1:4100/a/b?token=a",
	} {
		if _, err := parseDSN(input, 0); ErrorCode(err) != CodeConfig {
			t.Fatalf("parseDSN(%q) = %v; want CONFIG", input, err)
		}
	}
}

// fakeServer receives one connection's messages in place of the flowmark server, records them, and writes the script's replies in order.
type fakeServer struct {
	ln       net.Listener
	received chan []string
}

func startFakeServer(t *testing.T, answers ...string) *fakeServer {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &fakeServer{ln: ln, received: make(chan []string, 1)}
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			s.received <- nil
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		var got []string
		for _, answer := range answers {
			line, err := r.ReadString('\n')
			if err != nil {
				break
			}
			got = append(got, strings.TrimSuffix(line, "\n"))
			if _, err := conn.Write([]byte(answer + "\n")); err != nil {
				break
			}
		}
		s.received <- got
	}()
	t.Cleanup(func() { ln.Close() })
	return s
}

func (s *fakeServer) dsn() string {
	return "markdown://" + s.ln.Addr().String() + "/tracker?token=0123456789abcdef0123456789abcdef"
}

const connectLine = `{"op":"connect","corpus":"tracker","token":"0123456789abcdef0123456789abcdef"}`

// TestMarkdownSessionMessages checks the connect and control messages the client sends, and the interpretation of error lines
// (docs/spec/protocol.md §5).
func TestMarkdownSessionMessages(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	s := startFakeServer(t,
		`{"ok":true}`,
		`{"ok":true}`, `{"ok":true}`, `{"ok":true}`, `{"ok":true}`,
		`{"ok":true}`, `{"error":{"code":"WRITE_CONFLICT","message":"people.flowmark.md:3 changed since it was read"}}`,
	)
	db, err := Connect(s.dsn(), Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Transaction(func() error {
		return db.Transaction(func() error { return nil })
	}, ReadOnly()); err != nil {
		t.Fatal(err)
	}
	err = db.Transaction(func() error { return nil })
	var e *Error
	if !errors.As(err, &e) || e.Code != CodeWriteConflict || e.Msg != "people.flowmark.md:3 changed since it was read" {
		t.Fatalf("commit error = %v; want WRITE_CONFLICT with the server's message", err)
	}
	db.Close()
	want := []string{
		connectLine,
		`{"op":"begin","read_only":true}`,
		`{"op":"savepoint","name":"orm_sp_1"}`,
		`{"op":"release","name":"orm_sp_1"}`,
		`{"op":"commit"}`,
		`{"op":"begin"}`,
		`{"op":"commit"}`,
	}
	if got := <-s.received; !reflect.DeepEqual(got, want) {
		t.Fatalf("messages:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// TestMarkdownConnectRefused checks that the CONFIG the server answered to connect is an error of Connect.
func TestMarkdownConnectRefused(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	s := startFakeServer(t, `{"error":{"code":"CONFIG","message":"connect: the token is not the corpus's token"}}`)
	db, err := Connect(s.dsn(), Config{})
	if err == nil {
		db.Close()
	}
	var e *Error
	if !errors.As(err, &e) || e.Code != CodeConfig || e.Msg != "connect: the token is not the corpus's token" {
		t.Fatalf("Connect error = %v; want the server's CONFIG", err)
	}
	if got := <-s.received; !reflect.DeepEqual(got, []string{connectLine}) {
		t.Fatalf("messages = %q", got)
	}
}

// TestMarkdownRejectedSurfaces checks that a markdown connection refuses SQL-only surfaces with CAPABILITY_UNSUPPORTED
// (docs/spec/dialects.md "Markdown IR executor").
func TestMarkdownRejectedSurfaces(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	s := startFakeServer(t, `{"ok":true}`)
	db, err := Connect(s.dsn(), Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for name, err := range map[string]error{
		"isolation":   db.Transaction(func() error { return nil }, Isolation(Serializable)),
		"timeoutMs":   db.Transaction(func() error { return nil }, TimeoutMs(100)),
		"lock":        db.Utils().Lock("k"),
		"setLocal":    db.Utils().SetLocal("k", "v"),
		"subscribe":   subscribeErr(db),
		"waitingLock": waitingErr(db),
	} {
		if ErrorCode(err) != CodeCapabilityUnsupported {
			t.Fatalf("%s: %v; want CAPABILITY_UNSUPPORTED", name, err)
		}
	}
}

func subscribeErr(db *DB) error {
	_, err := db.Subscribe(func(StatementEvent) error { return nil })
	return err
}

func waitingErr(db *DB) error {
	_, err := db.BackendWaitingForLock(db.ctx)
	return err
}
