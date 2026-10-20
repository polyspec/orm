package orm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
)

// markdownDSN is the flowmark server address, corpus name, and token of a markdown:// DSN
// (docs/spec/protocol.md §5 "IR executors").
type markdownDSN struct {
	address string
	corpus  string
	token   string
}

// parseMarkdownDSN reads markdown://127.0.0.1:<port>/<corpus>?token=<token>. flowmark
// server listens only on 127.0.0.1, and since the token travels in plain text, the host is only 127.0.0.1.
func parseMarkdownDSN(u *url.URL, q url.Values) (markdownDSN, error) {
	const form = "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>"
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
	corpus := strings.TrimPrefix(u.Path, "/")
	if corpus == "" || strings.Contains(corpus, "/") {
		return markdownDSN{}, configErr("%s; the path %q is not one corpus name: give the corpus root's directory name", form, u.Path)
	}
	tokens := q["token"]
	if len(tokens) != 1 || tokens[0] == "" {
		return markdownDSN{}, configErr("%s; give one token, the token of .flowmark/server.json of the corpus", form)
	}
	q.Del("token")
	for key := range q {
		return markdownDSN{}, configErr("%s; it does not accept %s", form, key)
	}
	return markdownDSN{address: u.Host, corpus: corpus, token: tokens[0]}, nil
}

// unsupportedOnMarkdown is the error that SQL-only surfaces receive on a markdown connection (docs/spec/dialects.md
// "Markdown IR executor"). On other connections it is nil.
func (d *DB) unsupportedOnMarkdown(surface string) error {
	if d.md == nil {
		return nil
	}
	return &ir.Error{Code: CodeCapabilityUnsupported, Msg: surface + " is not supported by the markdown IR executor"}
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

type mdControl struct {
	Op       string `json:"op"`
	ReadOnly bool   `json:"read_only,omitempty"`
	Name     string `json:"name,omitempty"`
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
		return nil, &ir.Error{Code: CodeInternal, Msg: fmt.Sprintf("the flowmark server answered %q, not a JSON object", answer)}
	}
	if raw, ok := probe["error"]; ok {
		var e struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(raw, &e); err != nil || e.Code == "" {
			s.close()
			return nil, &ir.Error{Code: CodeInternal, Msg: fmt.Sprintf("the flowmark server answered the error %s without a code", raw)}
		}
		// The server writes CONNECTION_LOST and then closes the connection (idle transaction).
		if e.Code == CodeConnectionLost {
			s.close()
		}
		return nil, &ir.Error{Code: e.Code, Msg: e.Message}
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

// mdPool is the session pool of a markdown connection. Open sessions do not exceed Config.PoolSize,
// and idle sessions are kept up to PoolIdleSize.
type mdPool struct {
	dsn      markdownDSN
	idleSize int
	lifetime time.Duration
	slots    chan struct{}

	mu     sync.Mutex
	idle   []*mdSession
	open   int
	inUse  int
	closed bool
	// closeErr joins the errors of closing the sessions that the pool discarded; close returns it.
	closeErr error
}

func newMarkdownPool(dsn markdownDSN, cfg Config) *mdPool {
	return &mdPool{dsn: dsn, idleSize: cfg.PoolIdleSize, lifetime: time.Duration(cfg.PoolLifetimeMs) * time.Millisecond, slots: make(chan struct{}, cfg.PoolSize)}
}

// acquire hands out an idle session or connects a new one. If the open sessions are at PoolSize, it waits
// until one returns.
func (p *mdPool) acquire(ctx context.Context) (*mdSession, error) {
	select {
	case p.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, &ir.Error{Code: CodeCanceled, Msg: ctx.Err().Error(), Cause: ctx.Err()}
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		<-p.slots
		return nil, configErr("database is closed")
	}
	for len(p.idle) > 0 {
		s := p.idle[len(p.idle)-1]
		p.idle = p.idle[:len(p.idle)-1]
		if p.lifetime > 0 && time.Since(s.created) >= p.lifetime {
			p.discard(s)
			continue
		}
		p.inUse++
		p.mu.Unlock()
		return s, nil
	}
	p.open++
	p.inUse++
	p.mu.Unlock()
	s, err := dialMarkdown(ctx, p.dsn)
	if err != nil {
		p.mu.Lock()
		p.open--
		p.inUse--
		p.mu.Unlock()
		<-p.slots
		return nil, err
	}
	return s, nil
}

// release returns the session to the pool. Broken sessions and sessions of a closed pool are closed.
func (p *mdPool) release(s *mdSession) {
	p.mu.Lock()
	p.inUse--
	if s.broken || p.closed || len(p.idle) >= p.idleSize {
		p.discard(s)
	} else {
		p.idle = append(p.idle, s)
	}
	p.mu.Unlock()
	<-p.slots
}

// discard closes the session, which leaves the pool, and keeps the error of closing it. p.mu is held.
func (p *mdPool) discard(s *mdSession) {
	s.close()
	p.closeErr = errors.Join(p.closeErr, s.closeErr)
	p.open--
}

// close closes the pool and its idle sessions, and returns the errors of closing the sessions it discarded. A session
// in use when the pool closes is closed when it is released.
func (p *mdPool) close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	for _, s := range p.idle {
		p.discard(s)
	}
	p.idle = nil
	return p.closeErr
}

func (p *mdPool) stats() DBStats {
	p.mu.Lock()
	defer p.mu.Unlock()
	return DBStats{MaxOpenConnections: cap(p.slots), OpenConnections: p.open, InUse: p.inUse, Idle: len(p.idle)}
}

// openMarkdown opens a markdown connection. It connects one session to check that the server accepts
// the corpus and token, and puts it in the pool.
func openMarkdown(ctx context.Context, dsn parsedDSN, cfg Config) (*DB, error) {
	switch {
	case cfg.StatementTimeoutMs > 0:
		return nil, &ir.Error{Code: CodeCapabilityUnsupported, Msg: "statement timeout is not supported by the markdown IR executor"}
	case cfg.PoolSize < 0:
		return nil, configErr("pool size must not be negative")
	case cfg.PoolLifetimeMs < 0:
		return nil, configErr("pool lifetime must not be negative")
	}
	if cfg.PoolSize == 0 {
		cfg.PoolSize = defaultPoolSize
	}
	if cfg.PoolIdleSize < 0 || cfg.PoolIdleSize > cfg.PoolSize {
		return nil, configErr("pool idle size must be between 0 and the pool size %d", cfg.PoolSize)
	}
	if cfg.PoolIdleSize == 0 {
		cfg.PoolIdleSize = cfg.PoolSize
	}
	pool := newMarkdownPool(dsn.markdown, cfg)
	s, err := pool.acquire(ctx)
	if err != nil {
		return nil, err
	}
	pool.release(s)
	return &DB{md: pool, ctx: ctx, m: &dbMutable{engines: nil, schemas: map[string]*Schema{}}, cfg: cfg, driver: dsn.driver, location: dsn.location}, nil
}

// markdownModel is the runtime model of the schema registered on this connection. A manifest that is not registered
// is SCHEMA_HASH_MISMATCH, as on an SQL connection.
func (d *DB) markdownModel(s *Schema) (*runtimemodel.Model, error) {
	if s == nil {
		return nil, configErr("the model has no schema")
	}
	m, err := s.Model()
	if err != nil {
		return nil, err
	}
	d.m.engineMu.RLock()
	registered := d.m.schemas[s.Hash] != nil
	d.m.engineMu.RUnlock()
	if !registered {
		return nil, &ir.Error{Code: CodeSchemaHashMismatch, Msg: fmt.Sprintf("manifest %s is not registered on this connection: connect through its generated package or register it", s.Hash)}
	}
	return m, nil
}

// mdRequest is one request message: {ir_version, manifest_hash, request, params, now}.
type mdRequest struct {
	IRVersion    int               `json:"ir_version"`
	ManifestHash string            `json:"manifest_hash"`
	Request      *ir.Request       `json:"request"`
	Params       []json.RawMessage `json:"params"`
	Now          string            `json:"now"`
}

// markdownCall validates r and runs its request message in ex's session, and returns the answer.
// Outside a transaction, it uses one session from the pool for the duration of the request.
func markdownCall(ex executor, r *request) (json.RawMessage, *runtimemodel.Model, error) {
	if r.err != nil {
		return nil, nil, r.err
	}
	d, ctx := ex.base(), ex.context()
	m, err := d.markdownModel(r.schema)
	if err != nil {
		return nil, nil, err
	}
	r.ir.NParams = len(r.params)
	if err := ir.Validate(m, &r.ir); err != nil {
		return nil, nil, err
	}
	uses := ir.ParamUses(m, &r.ir)
	for i, v := range r.params {
		for _, u := range uses[i] {
			if err := checkAssign(i, v, useSlotType(u)); err != nil {
				return nil, nil, err
			}
			if u.Column != nil {
				if _, host := splitHost(u.Column.Codec); len(host) > 0 {
					continue
				}
			}
			if err := d.checkParam(i, v, useSlotType(u)); err != nil {
				return nil, nil, err
			}
		}
	}
	msg := mdRequest{IRVersion: r.ir.IRVersion, ManifestHash: r.ir.ManifestHash, Request: &r.ir, Params: make([]json.RawMessage, len(r.params)), Now: d.now().Format("2006-01-02 15:04:05.000000")}
	for i, v := range r.params {
		if msg.Params[i], err = d.markdownParam(i, v, uses[i]); err != nil {
			return nil, nil, err
		}
	}
	if t := ex.transaction(); t != nil {
		answer, err := t.md.call(ctx, msg)
		return answer, m, err
	}
	s, err := d.md.acquire(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer d.md.release(s)
	answer, err := s.call(ctx, msg)
	return answer, m, err
}

// markdownParam is the runtime value model JSON of parameter i: a decimal is a string, and bytes
// are base64, datetime is UTC as YYYY-MM-DD HH:MM:SS.ffffff, date is YYYY-MM-DD, and time is
// HH:MM:SS.ffffff (digits after p are 0). Time values in string form are written in that form too. Which form applies is decided by the type of the slot the parameter fills. hex and ip
// style column slots are encoded by the client and sent, as on SQL connections.
func (d *DB) markdownParam(i int, v any, uses []ir.ParamUse) (json.RawMessage, error) {
	var use ir.ParamUse
	if len(uses) > 0 {
		use = uses[0]
	}
	if use.Column != nil && v != nil {
		if _, host := splitHost(use.Column.Codec); len(host) > 0 {
			var err error
			if v, err = HostEncode(v, host, d.cfg.AESKey); err != nil {
				return nil, err
			}
		}
	}
	switch x := v.(type) {
	case []byte:
		v = base64.StdEncoding.EncodeToString(x)
	case string:
		switch use.Type {
		case "bytes":
			v = base64.StdEncoding.EncodeToString([]byte(x))
		case "date", "time", "datetime":
			var err error
			if v, err = d.bindTimeValue(x, use.Type, 6); err != nil {
				return nil, err
			}
		}
	}
	b, err := marshalPlain(v)
	if err != nil {
		return nil, codecErr(CodeCodecEncode, "parameter %d (%T) has no JSON form: %v", i, v, err)
	}
	return b, nil
}

// mdNode is one node of the answer: one each for root, join, and relation. asm records the row layout of the node
// and children are that join and relation. The first row of the node decides the columns of asm, and later rows
// must have the same output in the same order.
type mdNode struct {
	q      *ir.Query
	ent    *runtimemodel.Entity
	m      *runtimemodel.Model
	groups bool
	asm    *plan.Assemble
	flat   *plan.Step
	scan   *scanInfo
	built  bool
	joins  map[string]*mdNode
	rels   map[string]*mdNode
}

// mdLinks is the join and relation values of one answer row. They are placed in the row's last cell.
type mdLinks struct {
	joins map[string][]any
	rels  map[string][][]any
}

func newMarkdownNode(m *runtimemodel.Model, q *ir.Query, groups bool) *mdNode {
	ent := m.Entities[q.Entity]
	n := &mdNode{q: q, ent: ent, m: m, groups: groups, asm: &plan.Assemble{Entity: ent.Name}, joins: map[string]*mdNode{}, rels: map[string]*mdNode{}}
	for _, j := range q.Joins {
		child := newMarkdownNode(m, j.Query, false)
		n.joins[j.Rel] = child
		n.asm.Children = append(n.asm.Children, &plan.Child{Rel: j.Rel, Kind: "join", Assemble: child.asm})
	}
	for _, rel := range q.Relations {
		child := newMarkdownNode(m, rel.Query, false)
		n.rels[rel.Rel] = child
		target := m.Entities[rel.Query.Entity]
		var parentKeys, childKeys []string
		for _, k := range rel.Keys {
			parentKeys = append(parentKeys, k.Left)
			childKeys = append(childKeys, k.Right)
		}
		n.asm.Children = append(n.asm.Children, &plan.Child{
			Rel: rel.Rel, Kind: rel.Kind, Flatten: rel.Query.Flatten, Assemble: child.asm,
			// If this row is the row that a relation row's foreign key points to, those rows belong to this row (same as the planner).
			Cascade: !rel.Query.NoCascadeDelete && slices.Equal(parentKeys, ent.PK) && !slices.Equal(childKeys, target.PK),
		})
	}
	return n
}

// mdMember is one JSON object member.
type mdMember struct {
	name  string
	value json.RawMessage
}

// members reads the members of a JSON object in order.
func members(raw json.RawMessage) ([]mdMember, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, fmt.Errorf("%s is not a JSON object", raw)
	}
	var out []mdMember
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		name, ok := tok.(string)
		if !ok {
			return nil, answerErr("an object member name %v is not a string", tok)
		}
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		out = append(out, mdMember{name: name, value: v})
	}
	return out, nil
}

func answerErr(format string, a ...any) error {
	return &ir.Error{Code: CodeInternal, Msg: "the flowmark answer: " + fmt.Sprintf(format, a...)}
}

// outCol is the placement of an output name: a subquery, a column function, or a column of a node entity.
// The markdown executor leaves every codec stage to the client, so the whole codec of the column is the
// style to decode.
func (n *mdNode) outCol(name string, index int) (plan.OutCol, error) {
	if n.groups && name == "row_count" {
		return plan.OutCol{Index: index, Name: name, Type: "i64"}, nil
	}
	if c := n.q.Columns; c != nil && !n.groups {
		if sub, ok := c.Sub[name]; ok {
			return plan.OutCol{Index: index, Name: name, Type: subType(n.m, sub)}, nil
		}
		if cf, ok := c.Fn[name]; ok {
			return plan.OutCol{Index: index, Name: name, Column: cf.Column, Type: ir.FunctionType(cf.Fn.Name, n.ent.Field(cf.Column))}, nil
		}
	}
	f := n.ent.Field(name)
	if f == nil {
		return plan.OutCol{}, answerErr("%s answers %s, which is no output of the request", n.ent.Name, name)
	}
	return plan.OutCol{Index: index, Name: name, Column: name, Type: f.Type, Styles: f.Codec}, nil
}

// subType is the type of a scalar subquery column.
func subType(m *runtimemodel.Model, sub *ir.Sub) string {
	switch sub.Agg {
	case "count":
		return "i64"
	case "avg":
		return "f64"
	}
	if f := m.Entities[sub.Query.Entity].Field(sub.Column); f != nil {
		return f.Type
	}
	return "text"
}

// build decides the columns and key of asm from the output of the node's first row.
func (n *mdNode) build(outputs []string) error {
	for i, name := range outputs {
		col, err := n.outCol(name, i)
		if err != nil {
			return err
		}
		n.asm.Columns = append(n.asm.Columns, col)
	}
	keys := n.ent.PK
	if n.groups {
		keys = n.q.GroupBy
	}
	for _, key := range keys {
		i := slices.Index(outputs, key)
		if i < 0 {
			return answerErr("%s answers no %s, a key of its rows", n.ent.Name, key)
		}
		n.asm.Key = append(n.asm.Key, plan.KeyRef{Column: key, Index: i})
	}
	n.flat = &plan.Step{Assemble: &plan.Assemble{Entity: n.asm.Entity, Columns: n.asm.Columns}}
	n.scan = &scanInfo{n: len(outputs), styled: styledScanCols(n.flat.Assemble)}
	n.built = true
	return nil
}

// row reads one row of the answer as a positional row of the node layout: the output values, and in the last cell, the join and
// relation rows.
func (n *mdNode) row(raw json.RawMessage) ([]any, error) {
	ms, err := members(raw)
	if err != nil {
		return nil, answerErr("a row of %s: %v", n.ent.Name, err)
	}
	var outputs []string
	for _, mb := range ms {
		if n.joins[mb.name] != nil || n.rels[mb.name] != nil {
			continue
		}
		outputs = append(outputs, mb.name)
	}
	if !n.built {
		if err := n.build(outputs); err != nil {
			return nil, err
		}
	}
	if len(outputs) != len(n.asm.Columns) {
		return nil, answerErr("a row of %s answers %v, another output than its first row", n.ent.Name, outputs)
	}
	vals := make([]any, len(outputs)+1)
	links := &mdLinks{}
	k := 0
	for _, mb := range ms {
		if child := n.joins[mb.name]; child != nil {
			if links.joins == nil {
				links.joins = map[string][]any{}
			}
			if string(mb.value) == "null" {
				links.joins[mb.name] = nil
				continue
			}
			jrow, err := child.row(mb.value)
			if err != nil {
				return nil, err
			}
			links.joins[mb.name] = jrow
			continue
		}
		if child := n.rels[mb.name]; child != nil {
			rows, err := child.relationRows(mb.value)
			if err != nil {
				return nil, err
			}
			if links.rels == nil {
				links.rels = map[string][][]any{}
			}
			links.rels[mb.name] = rows
			continue
		}
		col := n.asm.Columns[k]
		if col.Name != mb.name {
			return nil, answerErr("a row of %s answers %s where its first row answers %s", n.ent.Name, mb.name, col.Name)
		}
		v, err := answerValue(col.Type, mb.value)
		if err != nil {
			return nil, fmt.Errorf("%s.%s: %w", n.ent.Name, col.Name, err)
		}
		vals[k] = v
		k++
	}
	// The corpus catalog rejects aes columns, so it has no keyring (docs/spec/dialects.md).
	if err := decodeSelectedRow(vals[:len(outputs)], n.scan, n.flat, AESKeyring{}); err != nil {
		return nil, err
	}
	vals[len(outputs)] = links
	return vals, nil
}

// relationRows reads a relation's value as a list of rows: a one relation is an object or null, and a many
// relation is an array, and a key_by relation is an object grouped by key.
func (n *mdNode) relationRows(raw json.RawMessage) ([][]any, error) {
	trimmed := bytes.TrimSpace(raw)
	switch {
	case string(trimmed) == "null":
		return nil, nil
	case len(trimmed) > 0 && trimmed[0] == '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return nil, answerErr("relation rows of %s: %v", n.ent.Name, err)
		}
		return n.rows(items)
	case n.q.KeyBy != "":
		ms, err := members(trimmed)
		if err != nil {
			return nil, answerErr("keyed relation rows of %s: %v", n.ent.Name, err)
		}
		items := make([]json.RawMessage, len(ms))
		for i, mb := range ms {
			items[i] = mb.value
		}
		return n.rows(items)
	}
	r, err := n.row(trimmed)
	if err != nil {
		return nil, err
	}
	return [][]any{r}, nil
}

func (n *mdNode) rows(items []json.RawMessage) ([][]any, error) {
	out := make([][]any, len(items))
	for i, item := range items {
		r, err := n.row(item)
		if err != nil {
			return nil, err
		}
		out[i] = r
	}
	return out, nil
}

// answerValue reads one value of the answer as a Go value of the column type. The value is the same as a parameter's
// runtime value model.
func answerValue(typ string, raw json.RawMessage) (any, error) {
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil, nil
	}
	bad := func() error {
		return codecErr(CodeCodecDecode, "the answer value %s is not a %s value", raw, typ)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, bad()
	}
	switch typ {
	case "i16", "i32", "i64":
		n, ok := v.(json.Number)
		if !ok {
			return nil, bad()
		}
		i, err := n.Int64()
		if err != nil {
			return nil, bad()
		}
		return i, nil
	case "f64":
		n, ok := v.(json.Number)
		if !ok {
			return nil, bad()
		}
		f, err := n.Float64()
		if err != nil {
			return nil, bad()
		}
		return f, nil
	case "bool":
		b, ok := v.(bool)
		if !ok {
			return nil, bad()
		}
		return b, nil
	case "bytes":
		s, ok := v.(string)
		if !ok {
			return nil, bad()
		}
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return nil, bad()
		}
		return b, nil
	}
	s, ok := v.(string)
	if !ok {
		return nil, bad()
	}
	return s, nil
}

// aggregateValue is the value of a sum or avg answer: an integer, a decimal, a decimal string, or nil if there is none.
func aggregateValue(raw json.RawMessage) (any, error) {
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, answerErr("the aggregate %s: %v", raw, err)
	}
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i, nil
		}
		return x.Float64()
	case string:
		return x, nil
	}
	return nil, answerErr("the aggregate %s is no number", raw)
}

// markdownRead reads the answer of a row read (one, all, group_count, paginate) as a positional result.
// The result's plan is one layout of the root node, and the last cell of each row holds that row's join and relation.
func markdownRead(ex executor, r *request) (*result, int64, error) {
	answer, m, err := markdownCall(ex, r)
	if err != nil {
		return nil, 0, err
	}
	var a struct {
		Rows  []json.RawMessage `json:"rows"`
		Count *int64            `json:"count"`
	}
	if err := json.Unmarshal(answer, &a); err != nil || a.Rows == nil {
		return nil, 0, answerErr("a %s answer %s has no rows", r.ir.Kind, answer)
	}
	if r.ir.Kind == "paginate" && a.Count == nil {
		return nil, 0, answerErr("a paginate answer %s has no count", answer)
	}
	root := newMarkdownNode(m, &r.ir.Query, r.ir.Kind == "group_count")
	if root.groups && len(a.Rows) == 0 {
		// An empty group answer has no first row to name the outputs, so they are the group_by keys and
		// row_count, the same outputs every group row answers.
		if err := root.build(append(slices.Clone(r.ir.GroupBy), "row_count")); err != nil {
			return nil, 0, err
		}
	}
	main, err := root.rows(a.Rows)
	if err != nil {
		return nil, 0, err
	}
	res := &result{cache: &cached{}, plan: &plan.Plan{Kind: r.ir.Kind, Steps: []plan.Step{{Role: "main", Assemble: root.asm}}}, main: main, params: r.params, markdown: true}
	var count int64
	if a.Count != nil {
		count = *a.Count
	}
	return res, count, nil
}

// markdownScalar is the answer of count, sum, and avg.
func markdownScalar(ex executor, r *request) (any, error) {
	answer, _, err := markdownCall(ex, r)
	if err != nil {
		return nil, err
	}
	var a map[string]json.RawMessage
	if err := json.Unmarshal(answer, &a); err != nil {
		return nil, answerErr("%s", err)
	}
	if r.ir.Kind == "count" {
		var n int64
		if err := json.Unmarshal(a["count"], &n); err != nil {
			return nil, answerErr("a count answer %s has no count", answer)
		}
		return n, nil
	}
	raw, ok := a["value"]
	if !ok {
		return nil, answerErr("a %s answer %s has no value", r.ir.Kind, answer)
	}
	return aggregateValue(raw)
}

// markdownWrite is the write answer {affected, keys}. keys holds the primary keys of the inserted rows in insert
// order: an identity is an integer, and a key_prefix key is text.
func markdownWrite(ex executor, r *request) ([]any, int64, error) {
	answer, _, err := markdownCall(ex, r)
	if err != nil {
		return nil, 0, err
	}
	var a struct {
		Affected *int64            `json:"affected"`
		Keys     []json.RawMessage `json:"keys"`
	}
	if err := json.Unmarshal(answer, &a); err != nil || a.Affected == nil {
		return nil, 0, answerErr("a %s answer %s has no affected", r.ir.Kind, answer)
	}
	keys := make([]any, len(a.Keys))
	for i, raw := range a.Keys {
		v, err := aggregateValue(raw)
		if err != nil {
			return nil, 0, err
		}
		keys[i] = v
	}
	if r.ir.Kind == "update" && r.ir.Optimistic != nil && *a.Affected == 0 {
		return nil, 0, &ir.Error{Code: CodeOptimisticLock, Msg: "the row changed after it was read"}
	}
	return keys, *a.Affected, nil
}

// markdownLinks is the join and relation that a markdown answer row holds in its last cell.
func markdownLinks(row []any) (*mdLinks, error) {
	last := row[len(row)-1]
	if last == nil {
		return &mdLinks{}, nil
	}
	links, ok := last.(*mdLinks)
	if !ok {
		return nil, internalErr("the last cell of a markdown answer row holds %T, not the join and relation values", last)
	}
	if links == nil {
		return &mdLinks{}, nil
	}
	return links, nil
}

// beginMessage is the begin control message of a transaction: a read-only transaction sends read_only true, any
// other leaves the member out (docs/spec/protocol.md §5 Session, the control cases of tests/bind/vectors.json).
func beginMessage(readOnly bool) mdControl {
	return mdControl{Op: "begin", ReadOnly: readOnly}
}

// beginMarkdown opens a markdown transaction: it holds one session from the pool until the transaction ends,
// and sends begin. A read-only transaction sends read_only.
func (d *DB) beginMarkdown(o txOptions) (*txConn, error) {
	if o.isolation != "" {
		return nil, d.unsupportedOnMarkdown("the transaction isolation option")
	}
	ctx, cancel := context.WithCancel(d.ctx)
	s, err := d.md.acquire(ctx)
	if err != nil {
		cancel()
		return nil, err
	}
	if _, err := s.call(ctx, beginMessage(o.readOnly)); err != nil {
		d.md.release(s)
		cancel()
		return nil, err
	}
	return &txConn{db: d, md: s, ctx: ctx, cancel: cancel, readOnly: o.readOnly, number: d.nextTransaction()}, nil
}

// endMarkdown ends the transaction and returns the session to the pool. If the context has ended, it closes the connection
// without sending a message: the server rolls back the transaction of the closed connection.
func (t *txConn) endMarkdown(op string) error {
	t.finished.Store(true)
	var err error
	if t.ctx.Err() != nil {
		t.md.close()
		if op == "commit" {
			err = &ir.Error{Code: CodeCanceled, Msg: t.ctx.Err().Error(), Cause: t.ctx.Err()}
		}
	} else {
		_, err = t.md.call(t.ctx, mdControl{Op: op})
	}
	t.db.md.release(t.md)
	t.cancel()
	return err
}

// savepointMarkdown sends one savepoint control message: savepoint, release, or rollback_to.
func (t *txConn) savepointMarkdown(op, name string) error {
	_, err := t.md.call(t.ctx, mdControl{Op: op, Name: name})
	return err
}
