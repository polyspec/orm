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

// markdownDSN은 markdown:// DSN의 flowmark server 주소, corpus 이름, token이다
// (docs/protocol.md §5 "IR executors").
type markdownDSN struct {
	address string
	corpus  string
	token   string
}

// parseMarkdownDSN은 markdown://127.0.0.1:<port>/<corpus>?token=<token>을 읽는다. flowmark
// server는 127.0.0.1에서만 듣고 token은 평문으로 가므로 host는 127.0.0.1뿐이다.
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

// unsupportedOnMarkdown은 markdown 연결에서 SQL 전용 surface가 받는 오류다(docs/dialects.md
// "Markdown IR executor"). 다른 연결에서는 nil이다.
func (d *DB) unsupportedOnMarkdown(surface string) error {
	if d.md == nil {
		return nil
	}
	return &ir.Error{Code: CodeCapabilityUnsupported, Msg: surface + " is not supported by the markdown IR executor"}
}

// mdSession은 flowmark server와의 연결 하나, 곧 server session 하나다. 한 번에 한
// goroutine이 쓴다: pool이 내주거나 transaction이 잡는다.
type mdSession struct {
	conn    net.Conn
	in      *bufio.Reader
	created time.Time
	// broken은 연결을 더 쓸 수 없음을 뜻한다: 읽기나 쓰기가 실패했거나 context가 끊었거나
	// server가 연결을 끝낸다고 답했다.
	broken bool
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

// dialMarkdown은 server에 연결하고 첫 message connect로 corpus와 token을 보낸다.
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
		return nil, err
	}
	return s, nil
}

func (s *mdSession) close() {
	s.broken = true
	s.conn.Close()
}

// call은 message 하나를 한 줄로 보내고 답 한 줄을 읽는다. 답이 {"error": {code, message}}이면
// 그 code의 오류다. context가 끝나면 연결을 끊는다: server는 끊긴 연결의 transaction을
// rollback하고 lock을 푼다.
func (s *mdSession) call(ctx context.Context, msg any) (json.RawMessage, error) {
	if s.broken {
		return nil, &ir.Error{Code: CodeConnectionLost, Msg: "the flowmark session has ended"}
	}
	line, err := marshalPlain(msg)
	if err != nil {
		return nil, &ir.Error{Code: CodeInternal, Msg: "writing the message: " + err.Error(), Cause: err}
	}
	stop := context.AfterFunc(ctx, func() { s.conn.SetDeadline(time.Now()) })
	answer, err := s.exchange(append(line, '\n'))
	if !stop() && err == nil {
		// context가 답을 읽은 뒤에 끝났다: 연결의 deadline이 섰으므로 연결을 더 쓰지 않는다.
		s.close()
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
		// server는 CONNECTION_LOST를 쓴 뒤 연결을 닫는다(idle transaction).
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

// marshalPlain은 v의 JSON이다. HTML 문자를 escape하지 않아 값이 그대로 간다.
func marshalPlain(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// mdPool은 markdown 연결의 session pool이다. 열린 session은 Config.PoolSize를 넘지 않고,
// 쉬는 session은 PoolIdleSize까지 남긴다.
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
}

func newMarkdownPool(dsn markdownDSN, cfg Config) *mdPool {
	return &mdPool{dsn: dsn, idleSize: cfg.PoolIdleSize, lifetime: time.Duration(cfg.PoolLifetimeMs) * time.Millisecond, slots: make(chan struct{}, cfg.PoolSize)}
}

// acquire는 쉬는 session을 내주거나 새로 연결한다. 열린 session이 PoolSize이면 하나가
// 돌아올 때까지 기다린다.
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
			s.close()
			p.open--
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

// release는 session을 pool에 돌려준다. 끊긴 session과 닫힌 pool의 session은 닫는다.
func (p *mdPool) release(s *mdSession) {
	p.mu.Lock()
	p.inUse--
	if s.broken || p.closed || len(p.idle) >= p.idleSize {
		s.close()
		p.open--
	} else {
		p.idle = append(p.idle, s)
	}
	p.mu.Unlock()
	<-p.slots
}

func (p *mdPool) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	for _, s := range p.idle {
		s.close()
		p.open--
	}
	p.idle = nil
}

func (p *mdPool) stats() DBStats {
	p.mu.Lock()
	defer p.mu.Unlock()
	return DBStats{MaxOpenConnections: cap(p.slots), OpenConnections: p.open, InUse: p.inUse, Idle: len(p.idle)}
}

// openMarkdown은 markdown 연결을 연다. session 하나를 연결해 server가 corpus와 token을
// 받아들이는지 확인하고 pool에 둔다.
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

// markdownModel은 이 연결에 등록된 schema의 runtime model이다. 등록되지 않은 manifest는
// SQL 연결과 같이 SCHEMA_HASH_MISMATCH다.
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

// mdRequest는 request message 하나다: {ir_version, manifest_hash, request, params, now}.
type mdRequest struct {
	IRVersion    int               `json:"ir_version"`
	ManifestHash string            `json:"manifest_hash"`
	Request      *ir.Request       `json:"request"`
	Params       []json.RawMessage `json:"params"`
	Now          string            `json:"now"`
}

// markdownCall은 r을 검증하고 그 request message를 ex의 session에서 실행해 답을 돌려준다.
// transaction 밖이면 pool의 session 하나를 그 request 동안 쓴다.
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

// markdownParam은 parameter i의 runtime value model JSON이다: decimal은 string, bytes는
// base64, datetime은 UTC의 YYYY-MM-DD HH:MM:SS.ffffff, date는 YYYY-MM-DD, time은
// HH:MM:SS.ffffff다(p 뒤 자리는 0). time 값의 문자열도 그 form으로 쓴다. 어느 form인지는 parameter가 채우는 slot의 type이 정한다. hex와 ip
// style column의 slot은 SQL 연결처럼 client가 값을 encode해 보낸다.
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
	case time.Time:
		t := x.In(d.location)
		switch use.Type {
		case "date":
			v = t.Format("2006-01-02")
		case "time":
			v = t.Format("15:04:05.000000")
		default:
			v = t.Format("2006-01-02 15:04:05.000000")
		}
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

// mdNode는 답의 한 node다: root, join, relation 하나가 하나씩이다. asm은 node의 행 배치를
// 적고 children은 그 join과 relation이다. asm의 column은 node의 첫 행이 정하고 그 뒤 행은
// 같은 output을 같은 순서로 가져야 한다.
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

// mdLinks는 answer 행 하나의 join과 relation 값이다. 행의 마지막 칸에 둔다.
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
			// 이 행이 relation 행의 외래 key가 가리키는 행이면 그 행들은 이 행에 속한다(planner와 같다).
			Cascade: !rel.Query.NoCascadeDelete && slices.Equal(parentKeys, ent.PK) && !slices.Equal(childKeys, target.PK),
		})
	}
	return n
}

// mdMember는 JSON object member 하나다.
type mdMember struct {
	name  string
	value json.RawMessage
}

// members는 JSON object의 member를 순서대로 읽는다.
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
		name, _ := tok.(string)
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

// outCol은 output name의 배치다: subquery, column 함수, 아니면 node entity의 column이다.
// markdown executor는 모든 codec stage를 client에 맡기므로 column의 codec 전체가 decode할
// style이다.
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

// subType은 scalar subquery column의 type이다.
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

// build는 node의 첫 행의 output으로 asm의 column과 key를 정한다.
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

// row는 답의 행 하나를 node 배치의 위치 행으로 읽는다: output 값, 그리고 마지막 칸에 join과
// relation의 행이다.
func (n *mdNode) row(raw json.RawMessage) ([]any, error) {
	ms, err := members(raw)
	if err != nil {
		return nil, answerErr("a row of %s: %v", n.ent.Name, err)
	}
	var outputs []string
	var nested []mdMember
	for _, mb := range ms {
		if n.joins[mb.name] != nil || n.rels[mb.name] != nil {
			nested = append(nested, mb)
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
	// corpus catalog은 aes column을 거절하므로 keyring이 없다(docs/dialects.md).
	if err := decodeSelectedRow(vals[:len(outputs)], n.scan, n.flat, AESKeyring{}); err != nil {
		return nil, err
	}
	vals[len(outputs)] = links
	return vals, nil
}

// relationRows는 relation의 값을 행 목록으로 읽는다: one relation은 object나 null, many
// relation은 array, key_by relation은 key로 묶은 object다.
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

// answerValue는 답의 값 하나를 column type의 Go 값으로 읽는다. 값은 parameter와 같은
// runtime value model이다.
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

// aggregateValue는 sum과 avg 답의 값이다: 정수, 소수, decimal string, 없으면 nil이다.
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

// markdownRead는 row read(one, all, group_count, paginate)의 답을 위치 result로 읽는다.
// result의 plan은 root node의 배치 하나이고, 각 행의 마지막 칸이 그 join과 relation이다.
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

// markdownScalar는 count, sum, avg의 답이다.
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

// markdownWrite는 write의 답 {affected, keys}이다. keys는 insert한 행의 primary key를 insert
// 순서로 담는다: identity는 정수, key_prefix key는 text다.
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

// markdownLinks는 markdown 답의 행이 마지막 칸에 가진 join과 relation이다.
func markdownLinks(row []any) *mdLinks {
	links, _ := row[len(row)-1].(*mdLinks)
	if links == nil {
		return &mdLinks{}
	}
	return links
}

// beginMarkdown은 markdown transaction을 연다: pool의 session 하나를 transaction이 끝날
// 때까지 잡고 begin을 보낸다. 읽기 전용 transaction은 read_only를 보낸다.
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
	if _, err := s.call(ctx, mdControl{Op: "begin", ReadOnly: o.readOnly}); err != nil {
		d.md.release(s)
		cancel()
		return nil, err
	}
	return &txConn{db: d, md: s, ctx: ctx, cancel: cancel, readOnly: o.readOnly, number: d.nextTransaction()}, nil
}

// endMarkdown은 transaction을 끝내고 session을 pool에 돌려준다. context가 끝났으면 message를
// 보내지 않고 연결을 끊는다: server가 끊긴 연결의 transaction을 rollback한다.
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

// savepointMarkdown은 savepoint control message 하나를 보낸다: savepoint, release, rollback_to.
func (t *txConn) savepointMarkdown(op, name string) error {
	_, err := t.md.call(t.ctx, mdControl{Op: op, Name: name})
	return err
}
