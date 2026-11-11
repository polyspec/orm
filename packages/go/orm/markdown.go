package orm

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/polyspec/orm/packages/go/engine"
	"github.com/polyspec/orm/packages/go/internal/message"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
)

// markdownDSN is the flowmark server address, corpus name, and token of a markdown:// DSN
// (docs/spec/protocol.md §5 "Markdown connections").
type markdownDSN struct {
	address string
	corpus  string
	token   string
	// pragmas are the _pragma values of the DSN, name(value), which each connection states first, as on a SQLite DSN.
	pragmas []string
}

// markdownForm is the form of a markdown DSN that its refusals name (PRT-63).
const markdownForm = "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>"

// parseMarkdownDSN reads markdown://127.0.0.1:<port>/<corpus>?token=<token>. flowmark
// server listens only on 127.0.0.1, and since the token travels in plain text, the host is only 127.0.0.1.
// path is the path of the DSN as written, decoded here as every DSN path is (CFG-11).
func parseMarkdownDSN(u *url.URL, path string, q map[string][]string) (markdownDSN, error) {
	const form = markdownForm
	// readDSNQuery has refused another parameter, a repeated or empty token and an invalid encoding (CFG-20); the token,
	// the user, the host, the port and the corpus follow in that order, and parseDSN checks timezone and then _pragma.
	tokens := q["token"]
	if len(tokens) == 0 {
		return markdownDSN{}, configErr("markdown DSN is missing the parameter %q", "token")
	}
	if u.User != nil {
		return markdownDSN{}, configErr("%s; it takes no user", form)
	}
	if u.Hostname() != "127.0.0.1" {
		return markdownDSN{}, configErr("%s; host %q: a flowmark server listens on 127.0.0.1 only", form, u.Hostname())
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return markdownDSN{}, configErr("%s; port %q is not 1 to 65535: give the port that flowmark serve printed", form, u.Port())
	}
	decoded, ok := decodedPath(path)
	corpus := strings.TrimPrefix(decoded, "/")
	if !ok || !strings.HasPrefix(decoded, "/") || corpus == "" || corpus == "." || corpus == ".." || strings.ContainsAny(corpus, "/\x00") {
		return markdownDSN{}, configErr("%s; the path %q is not one corpus name: give the corpus root's directory name", form, path)
	}
	return markdownDSN{address: u.Host, corpus: corpus, token: tokens[0], pragmas: q["_pragma"]}, nil
}

// mdSession is one connection to the flowmark server, that is, one server session. Only one
// goroutine uses it at a time: the pool hands it out, or a transaction holds it.
type mdSession struct {
	conn    net.Conn
	in      *bufio.Reader
	created time.Time
	// broken means the connection can no longer be used: a read or write failed, the context cut it off,
	// or the server answered that it ends the connection.
	broken bool
	// closed means the connection is closed, and closeErr is the error of closing it.
	closed   bool
	closeErr error
}

type mdConnect struct {
	Op     string `json:"op"`
	Corpus string `json:"corpus"`
	Token  string `json:"token"`
}

// dialMarkdown connects to the server and sends the corpus and token in the first connect message.
func dialMarkdown(ctx context.Context, dsn markdownDSN) (*mdSession, error) {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp4", dsn.address)
	if err != nil {
		if ctx.Err() != nil {
			return nil, &ir.Error{Code: CodeCanceled, Msg: ctx.Err().Error(), Cause: ctx.Err()}
		}
		return nil, &ir.Error{Code: CodeDriver, Msg: fmt.Sprintf("connecting to the flowmark server %s: %v; start flowmark serve for the corpus", dsn.address, err), Cause: err}
	}
	s := &mdSession{conn: conn, in: bufio.NewReader(conn), created: time.Now()}
	if _, err := s.call(ctx, mdConnect{Op: "connect", Corpus: dsn.corpus, Token: dsn.token}); err != nil {
		s.close()
		if s.closeErr != nil {
			return nil, errors.Join(err, s.closeErr)
		}
		return nil, err
	}
	return s, nil
}

// close ends the session: it is not used again, and its connection is closed once. The error of closing it is
// kept in closeErr, which the pool that discards the session returns from its close.
func (s *mdSession) close() {
	s.broken = true
	if !s.closed {
		s.closed = true
		s.closeErr = s.conn.Close()
	}
}

// call sends one message in one line and reads one reply line. If the reply is {"error": {code, message}},
// it is an error with that code. When the context ends, it closes the connection: the server
// rolls back the transaction of the closed connection and releases its locks.
func (s *mdSession) call(ctx context.Context, msg any) (json.RawMessage, error) {
	if s.broken {
		return nil, &ir.Error{Code: CodeConnectionLost, Msg: "the flowmark session has ended"}
	}
	line, err := marshalPlain(msg)
	if err != nil {
		return nil, &ir.Error{Code: CodeInternal, Msg: "writing the message: " + err.Error(), Cause: err}
	}
	deadline := make(chan error, 1)
	stop := context.AfterFunc(ctx, func() { deadline <- s.conn.SetDeadline(time.Now()) })
	answer, err := s.exchange(append(line, '\n'))
	if !stop() {
		// The context ended and its function set the connection's deadline; an error of setting it is an error of
		// the call. When the reply was read before, the connection's deadline has passed, so the connection is not used again.
		if err = errors.Join(err, <-deadline); err == nil {
			s.close()
		}
	}
	if err != nil {
		s.close()
		if ctx.Err() != nil {
			return nil, &ir.Error{Code: CodeCanceled, Msg: ctx.Err().Error(), Cause: ctx.Err()}
		}
		return nil, &ir.Error{Code: CodeConnectionLost, Msg: "the flowmark server connection broke: " + err.Error(), Cause: err}
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(answer, &probe); err != nil || probe == nil {
		s.close()
		return nil, &ir.Error{Code: CodeInternal, Msg: message.Sprintf("the flowmark server answered %q, not a JSON object", answer)}
	}
	if raw, ok := probe["error"]; ok {
		var e struct {
			Code       string `json:"code"`
			Message    string `json:"message"`
			ResultCode int    `json:"result_code"`
		}
		if err := json.Unmarshal(raw, &e); err != nil || e.Code == "" {
			s.close()
			return nil, &ir.Error{Code: CodeInternal, Msg: fmt.Sprintf("the flowmark server answered the error %s without a code", raw)}
		}
		// The server writes CONNECTION_LOST and then closes the connection (idle transaction).
		if e.Code == CodeConnectionLost {
			s.close()
		}
		return nil, &ir.Error{Code: e.Code, Msg: e.Message, Cause: &mdServerError{code: e.Code, message: e.Message, result: e.ResultCode}}
	}
	return answer, nil
}

func (s *mdSession) exchange(line []byte) ([]byte, error) {
	if _, err := s.conn.Write(line); err != nil {
		return nil, err
	}
	answer, err := s.in.ReadBytes('\n')
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, errors.New("the server closed the connection")
		}
		return nil, err
	}
	return bytes.TrimSuffix(answer, []byte("\n")), nil
}

// marshalPlain is the JSON of v. HTML characters are not escaped, so the value passes through as is.
func marshalPlain(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// openMarkdown opens a markdown connection. It connects one session to check that the server accepts
// the corpus and token, and puts it in the pool.
func openMarkdown(ctx context.Context, dsn parsedDSN, cfg Config) (*DB, error) {
	if err := poolOptions(&cfg); err != nil {
		return nil, err
	}
	pool := markdownStatementPool(dsn.markdown)
	pool.SetMaxOpenConns(cfg.PoolSize)
	pool.SetMaxIdleConns(cfg.PoolIdleSize)
	if err := pool.PingContext(ctx); err != nil {
		return nil, errors.Join(mapDriverErr(err, ""), pool.Close())
	}
	// A flowmark server runs SQL in SQLite's dialect (DIA-185): this connection is a SQLite connection whose statements it answers.
	return &DB{corpus: true, sql: pool, ctx: ctx, m: &dbMutable{engines: map[string]*engine.Engine{}, schemas: map[string]*Schema{}}, plans: map[uint64]*cached{}, stmts: map[string]*sql.Stmt{}, cfg: cfg, driver: "sqlite", location: dsn.location}, nil
}

// mdServerError is the refusal the flowmark server answered, as the cause a database driver's error is. Code is the
// SQLite result code it states, since the statements of a flowmark connection are in SQLite's dialect.
type mdServerError struct {
	code    string
	message string
	result  int
}

func (e *mdServerError) Error() string { return e.code + ": " + e.message }

func (e *mdServerError) Code() int { return e.result }
