// Package recipe runs the cases of a recipe (docs/spec/feature-coverage.md FCV-2 to FCV-4) in Go: the entry of each suite
// unit, TestRecipe<Recipe><Database>, starts its case with packages/go/testcase and calls Run with the recipe and the
// database, and Run runs each case as a subtest whose
// steps call the public API of the orm package that each op names.
package recipe

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	orderedjson "github.com/polyspec/ordered-json/packages/go"
	"github.com/polyspec/orm/packages/go/engine"
	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/orm"
	_ "modernc.org/sqlite"
)

// None is the database part of a recipe without a database (FCV-3).
const None = "none"

type file struct {
	Schema string       `json:"schema"`
	Cases  []recipeCase `json:"cases"`
}

type recipeCase struct {
	ID    string            `json:"id"`
	Steps []json.RawMessage `json:"steps"`
}

type step struct {
	Op      string                     `json:"op"`
	GenSet  string                     `json:"document_set"`
	Same    []string                   `json:"unchanged"`
	Diff    []string                   `json:"changed"`
	Gone    []string                   `json:"removed"`
	Tree    map[string]json.RawMessage `json:"files"`
	Parts   []string                   `json:"parts"`
	Compare bool                       `json:"check"`
	Keys    []collectionKey            `json:"keys"`
	Styles  []string                   `json:"styles"`
	Raw     json.RawMessage            `json:"raw"`
	Value   json.RawMessage            `json:"value"`
	Key     *string                    `json:"key"`
	As      string                     `json:"as"`
	Request json.RawMessage            `json:"request"`
	Chain   string                     `json:"chain"`
	Answer  json.RawMessage            `json:"answer"`
	Answers map[string]json.RawMessage `json:"answers"`
	DSN     string                     `json:"dsn"`
	Config  dsnConfig                  `json:"config"`
	Schema  string                     `json:"schema"`
	Input   json.RawMessage            `json:"input"`
	// AssembleTypes adds the output types of a compiled plan step to what a planner.compile step compares.
	AssembleTypes bool `json:"assemble_types"`
	// Names are the output names of a planner.columns step.
	Names []string `json:"names"`
	// ManifestHash is the hash an ir.validate request holds in place of the hash of the schema of the recipe.
	ManifestHash string            `json:"manifest_hash"`
	Lines        []string          `json:"lines"`
	Plan         json.RawMessage   `json:"plan"`
	Plans        []json.RawMessage `json:"plans"`
	Source       json.RawMessage   `json:"source"`
	Target       json.RawMessage   `json:"target"`
	Dialect      string            `json:"dialect"`
	// Documents and Document name the .dbs files of the dbspec ops, relative to the recipe file; Text is the lines of a document text.
	Documents []string  `json:"documents"`
	Document  string    `json:"document"`
	Text      textLines `json:"text"`
	// Set holds the other documents of an inline dbspec op, CRLF and Mixed its line endings, Owned and External the texts of
	// dbspec.parse_set, and Path the file of dbspec.read_file and dbspec.read_bytes.
	Set      map[string][]string `json:"set"`
	CRLF     bool                `json:"crlf"`
	Mixed    bool                `json:"mixed"`
	Owned    []string            `json:"owned"`
	Parsing  map[string]string   `json:"parsing"`
	External []string            `json:"external"`
	Path     string              `json:"path"`
	// Name, Mermaid and SkeletonOf are the fields of dbspec.import_mermaid: the name of the imported document, its Mermaid
	// text or a ref to an export, and the .dbs file whose skeleton the import must equal (FCV-4).
	Name        string                     `json:"name"`
	Corpus      string                     `json:"corpus"`
	Token       string                     `json:"token"`
	Reply       string                     `json:"reply"`
	Received    string                     `json:"received"`
	// Replies and Messages are the fields of markdown.session: the lines the listener answers and the lines it must receive.
	Replies  []string `json:"replies"`
	Messages []string `json:"messages"`
	// Surface is the public call of a markdown.send step that has no form on a markdown connection.
	Surface string `json:"surface"`
	Mermaid     json.RawMessage            `json:"mermaid"`
	SkeletonOf  string                     `json:"skeleton_of"`
	Expect      map[string]json.RawMessage `json:"expect"`
	Options     json.RawMessage            `json:"options"`
	Model       string                     `json:"model"`
	Column      string                     `json:"column"`
	Operator    string                     `json:"operator"`
	Params      []json.RawMessage          `json:"params"`
	Begin       json.RawMessage            `json:"begin"`
	ProcessZone string                     `json:"process_zone"`
	// SQL is the statements of dbspec.introspect_sqlite or dbspec.apply_fault.
	SQL []string `json:"sql"`
	// Call, AppliedFirst and FailCatalogRead are the fields of dbspec.apply_fault.
	Call            string `json:"call"`
	AppliedFirst    bool   `json:"applied_first"`
	FailCatalogRead int    `json:"fail_catalog_read"`
	// FailStatements are the statements of dbspec.apply_fault that fail in the call.
	FailStatements []struct {
		Statement    string `json:"statement"`
		Message      string `json:"message"`
		SQLiteResult int    `json:"sqlite_result"`
	} `json:"fail_statements"`
	// NoRowQueries are the queries of dbspec.apply_fault that return no row in the call.
	NoRowQueries []string `json:"no_row_queries"`
	// StopOnApplied is the message of the error of the first applied event of dbspec.apply_fault.
	StopOnApplied string `json:"stop_on_applied"`
	// Vectors is the file of dbspec.introspect_shown, relative to the recipe, and Case the id of its case.
	Vectors string `json:"vectors"`
	Case    string `json:"case"`
	// Keyring is the keyring of keyring.versions, Calls the builder calls of markdown.builder (FCV-4).
	Keyring *aesKeyringSpec `json:"keyring"`
	Calls   []string        `json:"calls"`
}

// MarkdownSend runs one markdown.send step on a markdown connection to a listener that records the first message it receives,
// and returns that message (the JSON of the message, or of the parameter of a statement) and the code of the error that the
// public call returned before it sent one. A begin step passes begin, the statement passes column, operator and params.
// A step with a surface passes that name.
// A non-empty processZone is the IANA zone name that is the process default zone while the step runs.
// It is supplied by the test package that owns the listener and the generated bind models, since they cannot be reached from here.
type MarkdownSend func(t *testing.T, column, operator string, params []json.RawMessage, begin *bool, surface, processZone string) (message json.RawMessage, code string)

// IRAnswer runs the chain of one ir.answer step on a listener that answers with the answer, or with answers keyed by the op of
// a control message or the kind of a request, and returns the result of the chain or its error. It is supplied by the test
// that owns the chain registry and the listener, since a chain cannot be reached from this package. With params set (the expect
// of the step is {"params": [...]}, PRT-66), the function returns the params of the request that the listener received instead.
type IRAnswer func(t *testing.T, chain string, answer json.RawMessage, answers map[string]json.RawMessage, params bool) (any, error)

// MarkdownBuilder runs one markdown.builder step: the builder calls on the generated model of the bind fixture, then its count
// terminal, on a listener that records a message. It returns the code and the text of the error of the terminal, and fails the test
// when a message reached the listener. It is supplied by the test package that owns the listener and the generated bind models.
type MarkdownBuilder func(t *testing.T, calls []string) (code, message string)

// Option configures Run.
type Option func(*options)

// ModelAssign runs one model.assign step: it sets column of a new row of the generated model model through its public setter
// with value, builds the insert statement without a database, and returns the JSON of its one parameter or the code of the
// error that the setter or the encode returns before it sends a message. It is supplied by the test package that owns the models.
type ModelAssign func(t *testing.T, model, column string, value json.RawMessage) (json.RawMessage, string)

type options struct {
	irAnswer IRAnswer
	// dir is the directory of the recipe file, which the dbspec ops resolve their documents against.
	dir             string
	markdownSend    MarkdownSend
	modelAssign     ModelAssign
	markdownBuilder MarkdownBuilder
}

// WithMarkdownBuilder supplies the function that runs each markdown.builder step of a recipe without a database.
func WithMarkdownBuilder(fn MarkdownBuilder) Option {
	return func(o *options) { o.markdownBuilder = fn }
}

// WithModelAssign supplies the function that runs each model.assign step of a recipe without a database.
func WithModelAssign(fn ModelAssign) Option {
	return func(o *options) { o.modelAssign = fn }
}

// WithMarkdownSend supplies the function that runs each markdown.send step of a recipe without a database.
func WithMarkdownSend(fn MarkdownSend) Option {
	return func(o *options) { o.markdownSend = fn }
}

// WithIRAnswer supplies the function that runs the chain of each ir.answer step of a recipe without a database.
func WithIRAnswer(fn IRAnswer) Option {
	return func(o *options) { o.irAnswer = fn }
}

// result is what a step produced: the decoded value of a decode, the cell of an encode, or the error of either.
type result struct {
	styled  orm.StyledValue // a codec.decode
	decoded bool
	cell    any // the cell or text of an encode, a host decode or a blind index
	err     error
	// dbspec is what a dbspec step bound: a *dbspec.Document (dbspec.parse) or a *dbspec.Plan (dbspec.parse_plan).
	dbspec any
}

// reportCase appends the pass of the running case to the file that ORM_RECIPE_RESULTS names, the line the feature
// checker reads (FCV-12). A run outside the checker names no file.
func reportCase(t *testing.T, id, database string) {
	t.Helper()
	path := os.Getenv("ORM_RECIPE_RESULTS")
	if path == "" || t.Failed() {
		return
	}
	line := "CASE " + id + " [" + database + "] PASS\n"
	if database == None {
		line = "CASE " + id + " PASS\n"
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("recipe results: %v", err)
	}
	defer func() {
		if err := file.Close(); err != nil {
			t.Errorf("recipe results: %v", err)
		}
	}()
	if _, err := file.WriteString(line); err != nil {
		t.Fatalf("recipe results: %v", err)
	}
}

// Run runs every case of the recipe at path, relative to the test's package directory, on database. The options configure
// the ops that need a function from the test, such as WithIRAnswer.
func Run(t *testing.T, path, database string, opts ...Option) {
	t.Helper()
	if database != None {
		runDatabase(t, path, database)
		return
	}
	o := options{dir: filepath.Dir(path)}
	for _, opt := range opts {
		opt(&o)
	}
	f := readRecipe[file](t, path)
	// A recipe with an ir.validate step names the schema manifest of its requests, relative to the recipe file (tests/ir/validate.json).
	var model *runtimemodel.Model
	if f.Schema != "" {
		var err error
		model, err = runtimemodel.LoadFiles(filepath.Join(filepath.Dir(path), f.Schema))
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range f.Cases {
		t.Run(c.ID, func(t *testing.T) {
			bound := map[string]result{}
			for index, raw := range c.Steps {
				var s step
				if err := json.Unmarshal(raw, &s); err != nil {
					t.Fatalf("recipe %s case %s step %d on %s: %v", path, c.ID, index, database, err)
				}
				if err := run(t, s, bound, database, model, o); err != nil {
					t.Fatalf("recipe %s case %s step %d (%s) on %s: %v", path, c.ID, index, s.Op, database, err)
				}
			}
			reportCase(t, c.ID, database)
		})
	}
}

// run maps the op of s to its call and checks the result against the expect of database.
func run(t *testing.T, s step, bound map[string]result, database string, model *runtimemodel.Model, o options) error {
	switch s.Op {
	case "planner.compile":
		return checkPlanner(o.dir, s, database)
	case "ir.param_uses":
		return checkParamUses(o.dir, s, database)
	case "planner.columns":
		return checkPlannerColumns(o.dir, s, database)
	case "generator.generate":
		return checkGenerator(t, o.dir, s, database)
	case "generator.check":
		return checkGeneratedFiles(o.dir, s)
	case "generator.refused":
		return checkRefusedGeneration(o.dir, s)
	case "dbspec.parse", "dbspec.parse_plan", "dbspec.emit_plan", "dbspec.diff", "dbspec.plan_steps", "dbspec.add_tables_steps", "dbspec.chain", "dbspec.compare":
		return dbspecStep(s, bound, database)
	case "dbspec.parse_emit", "dbspec.manifest", "dbspec.render", "dbspec.analyze", "dbspec.parse_positions", "dbspec.format",
		"dbspec.parse_set", "dbspec.set", "dbspec.load_set", "dbspec.runtime_model", "dbspec.read_file", "dbspec.read_bytes":
		return checkDBSpec(s, o.dir, database)
	case "dbspec.export_mermaid", "dbspec.import_mermaid":
		got, err := mermaidStep(s, bound, o.dir)
		if err != nil {
			return err
		}
		if s.As != "" {
			bound[s.As] = result{cell: got}
		}
		expect, ok := s.Expect[database]
		if !ok {
			return fmt.Errorf("%s has no expect for %s", s.Op, database)
		}
		return checkMermaid(expect, got)
	}
	if s.Op == "ir.validate" {
		return checkValidate(s.Expect[database], validate(model, s.Request, s.ManifestHash))
	}
	if s.Op == "ir.answer" {
		return checkAnswer(t, s, database, o.irAnswer)
	}
	if s.Op == "markdown.send" {
		return checkSend(t, s, o.markdownSend)
	}
	if s.Op == "model.assign" {
		return checkAssign(t, s, o.modelAssign)
	}
	if s.Op == "collection.key" {
		return checkCollectionKey(s, database)
	}
	if s.Op == "markdown.builder" {
		return checkBuilder(t, s, database, o.markdownBuilder)
	}
	if s.Op == "keyring.versions" {
		return checkKeyring(s, database)
	}
	if s.Op == "dbspec.introspect_shown" {
		return checkIntrospectShown(t, o.dir, s, database)
	}
	if s.Op == "dbspec.apply_fault" {
		return checkApplyFault(t, s, bound, database)
	}
	if s.Op == "dbspec.introspect_sqlite" {
		return checkIntrospectSQLite(t, s, database)
	}
	var r result
	switch s.Op {
	case "codec.decode":
		raw, err := argument(s.Raw, bound)
		if err != nil {
			return err
		}
		r.styled, r.err = orm.Decode(s.Styles, raw)
		r.decoded = true
	case "codec.encode":
		value, err := styledArgument(s.Value, s.Styles, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.Encode(s.Styles, value)
	case "codec.host_encode":
		value, err := argument(s.Value, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.HostEncode(value, s.Styles, key(s))
	case "codec.host_decode":
		raw, err := argument(s.Raw, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.HostDecode(raw, s.Styles, key(s))
	case "codec.blind_index":
		value, err := argument(s.Value, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.BlindIndex(value, key(s))
	// dsn.connect (FCV-4): the DSN text of the step opened with Connect; a DSN that is refused never touches a database.
	case "dsn.connect":
		r.cell, r.err = connectDriver(s.DSN, s.Config)
	// markdown.connect (FCV-4, PRT-64): Connect on a markdown DSN, whose listener answers the first line with the reply.
	case "markdown.connect":
		r.err = markdownConnect(s)
	// markdown.session (FCV-4, PRT-64): the control messages of two transactions on a listener that answers from replies.
	case "markdown.session":
		r.err = markdownSession(s)
	default:
		return fmt.Errorf("OP_UNKNOWN %s", s.Op)
	}
	if s.As != "" {
		bound[s.As] = r
	}
	expect, ok := s.Expect[database]
	if !ok {
		if r.err != nil {
			return fmt.Errorf("unexpected error %w", r.err)
		}
		return nil
	}
	return check(expect, r, s.Styles)
}

// dsnConfig is the config field of dsn.connect (FCV-4; CFG-4, CFG-5, CFG-6).
type dsnConfig struct {
	PoolSize           int  `json:"pool_size"`
	PoolIdleSize       int  `json:"pool_idle_size"`
	PoolLifetimeMs     int  `json:"pool_lifetime_ms"`
	StatementTimeoutMs int  `json:"statement_timeout_ms"`
	TLSVersion         bool `json:"tls_version"`
}

// sqliteFileName opens a SQLite DSN with the query on a new file called name, and returns the names in its directory
// other than the journals of that file (dsn.sqlite_file, CFG-26).
func sqliteFileName(name, query string) (string, error) {
	directory, err := os.MkdirTemp("", "orm-recipe-sqlite-name-")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(directory) }()
	_, refused := connectDriver("sqlite://"+filepath.Join(directory, name)+"?"+query, dsnConfig{})
	entries, err := os.ReadDir(directory)
	if err != nil {
		return "", err
	}
	if refused != nil {
		if len(entries) != 0 {
			return "", fmt.Errorf("a refused DSN left %d files in the directory: %v", len(entries), entries)
		}
		return "", refused
	}
	names := []string{}
	for _, entry := range entries {
		if !slices.Contains([]string{name + "-journal", name + "-shm", name + "-wal"}, entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	return strings.Join(names, ","), nil
}

// markdownConnect runs the markdown.connect op: it returns the outcome of the connection, or an error with no code when the
// listener did not receive the line of the step.
func markdownConnect(s step) error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer func() { _ = listener.Close() }()
	received := make(chan string, 1)
	go func() {
		defer close(received)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		line, _ := bufio.NewReader(conn).ReadString('\n')
		_, _ = fmt.Fprintln(conn, s.Reply)
		received <- strings.TrimRight(line, "\n")
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	_, connected := connectDriver(fmt.Sprintf("markdown://127.0.0.1:%d/%s?token=%s", port, s.Corpus, s.Token), dsnConfig{})
	if got := <-received; got != s.Received {
		return fmt.Errorf("the listener received %q, want %q", got, s.Received)
	}
	return connected
}

// markdownSession runs the markdown.session op: on a listener that answers each line with the next of the replies, a read-only
// transaction that holds a nested one, then a transaction. It returns the error of the last one, or an error with no code when
// the listener did not receive the messages of the step.
func markdownSession(s step) error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer func() { _ = listener.Close() }()
	received := make(chan []string, 1)
	go func() {
		var got []string
		defer func() { received <- got }()
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		lines := bufio.NewScanner(conn)
		for lines.Scan() {
			got = append(got, lines.Text())
			if len(got) <= len(s.Replies) {
				_, _ = fmt.Fprintln(conn, s.Replies[len(got)-1])
			}
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	db, err := orm.Connect(fmt.Sprintf("markdown://127.0.0.1:%d/%s?token=%s", port, s.Corpus, s.Token), orm.Config{})
	if err != nil {
		return fmt.Errorf("connect: %s", err.Error())
	}
	if err := db.Transaction(func() error {
		return db.Transaction(func() error { return nil })
	}, orm.ReadOnly()); err != nil {
		return fmt.Errorf("the read-only transaction: %s", err.Error())
	}
	failure := db.Transaction(func() error { return nil })
	if err := db.Close(); err != nil {
		return fmt.Errorf("close: %s", err.Error())
	}
	if got := <-received; !slices.Equal(got, s.Messages) {
		return fmt.Errorf("the listener received %q, want %q", got, s.Messages)
	}
	return failure
}

// connectDriver opens the DSN with Connect, runs SELECT 1 through the statement runner (INT-150), closes the connection
// and returns its driver: the one implementation of dsn.connect (FCV-4).
func connectDriver(dsn string, config dsnConfig) (string, error) {
	db, err := orm.Connect(dsn, orm.Config{
		PoolSize:           config.PoolSize,
		PoolIdleSize:       config.PoolIdleSize,
		PoolLifetimeMs:     config.PoolLifetimeMs,
		StatementTimeoutMs: config.StatementTimeoutMs,
	})
	if err != nil {
		return "", err
	}
	driver := db.Driver()
	answered := db.Utils().Run(func(f *orm.TxFrame) error {
		res, err := f.Run(orm.KindUtility, nil, "SELECT 1")
		if err != nil {
			return err
		}
		if len(res.Rows) != 1 || len(res.Rows[0]) != 1 {
			return fmt.Errorf("SELECT 1 on the connection of %s returned %v", driver, res.Rows)
		}
		cell := res.Rows[0][0]
		if text, isBytes := cell.([]byte); isBytes {
			cell = string(text)
		}
		if fmt.Sprint(cell) != "1" {
			return fmt.Errorf("SELECT 1 on the connection of %s returned %v", driver, res.Rows)
		}
		if !config.TLSVersion {
			return nil
		}
		status, err := f.Run(orm.KindUtility, nil, "SHOW SESSION STATUS LIKE 'Ssl_version'")
		if err != nil {
			return err
		}
		if len(status.Rows) != 1 || len(status.Rows[0]) != 2 {
			return fmt.Errorf("Ssl_version on the connection of %s returned %v", driver, status.Rows)
		}
		version := status.Rows[0][1]
		if text, isBytes := version.([]byte); isBytes {
			version = string(text)
		}
		if got := fmt.Sprint(version); got != "TLSv1.2" && got != "TLSv1.3" {
			return fmt.Errorf("the connection has Ssl_version %q, want TLSv1.2 or TLSv1.3", got)
		}
		return nil
	})
	closed := db.Close()
	if answered != nil {
		return "", answered
	}
	return driver, closed
}

func key(s step) string {
	if s.Key == nil {
		return ""
	}
	return *s.Key
}

// check compares r with the outcome {value} or {error} of an expect.
func check(raw json.RawMessage, r result, styles []string) error {
	var outcome struct {
		Value        json.RawMessage `json:"value"`
		Error        string          `json:"error"`
		MessageHolds string          `json:"message_holds"`
		BytesPrefix  string          `json:"bytes_prefix_hex"`
		BytesLength  int             `json:"bytes_length"`
	}
	if err := json.Unmarshal(raw, &outcome); err != nil {
		return err
	}
	if outcome.Error != "" {
		if got := orm.ErrorCode(r.err); got != outcome.Error {
			return fmt.Errorf("error %q (%w), want %s", got, r.err, outcome.Error)
		}
		if !strings.Contains(r.err.Error(), outcome.MessageHolds) {
			return fmt.Errorf("error %q, want a message that holds %q", r.err, outcome.MessageHolds)
		}
		return nil
	}
	if r.err != nil {
		return fmt.Errorf("unexpected error %w", r.err)
	}
	if outcome.BytesPrefix != "" {
		// An envelope has a random nonce, so its form is its prefix and its length (COD-5).
		cell, isBytes := r.cell.([]byte)
		if !isBytes || len(cell) != outcome.BytesLength || !strings.HasPrefix(hex.EncodeToString(cell), outcome.BytesPrefix) {
			return fmt.Errorf("cell %#v, want bytes of length %d with the prefix %s", r.cell, outcome.BytesLength, outcome.BytesPrefix)
		}
		return nil
	}
	want, err := wrapper(outcome.Value)
	if err != nil {
		return err
	}
	if !r.decoded {
		return compareCell(want, r.cell)
	}
	value, present := r.styled.Data()
	if !present {
		if want.kind != "null" {
			return fmt.Errorf("SQL NULL, want %s", want)
		}
		return nil
	}
	got, err := fromGo(value)
	if err != nil {
		return err
	}
	if !equal(got, want, slices.Contains(styles, "ordered_json")) {
		return fmt.Errorf("decoded %s, want %s", got, want)
	}
	return nil
}

// compareCell compares the cell of an encode, a host decode or a blind index with a wrapper: bytes by bytes, a text cell
// by its UTF-8 bytes (FCV-4), and SQL NULL with null.
func compareCell(want node, cell any) error {
	var got []byte
	switch c := cell.(type) {
	case nil:
		if want.kind != "null" {
			return fmt.Errorf("no cell, want %s", want)
		}
		return nil
	case string:
		got = []byte(c)
	case []byte:
		got = c
	default:
		return fmt.Errorf("cell of type %T", cell)
	}
	var expected []byte
	switch want.kind {
	case "bytes_hex":
		b, err := hex.DecodeString(want.text)
		if err != nil {
			return err
		}
		expected = b
	case "text":
		expected = []byte(want.text)
	default:
		return fmt.Errorf("a cell compares with bytes_hex or text, not %s", want.kind)
	}
	if !bytes.Equal(got, expected) {
		return fmt.Errorf("cell %x, want %x", got, expected)
	}
	return nil
}

// node is a recipe wrapper as a tree: its kind (int, float, text, bool, nil, null, bytes_hex, array, object, and the time
// forms), its text, and its items or members in order.
type node struct {
	kind    string
	text    string
	items   []node
	members []member
}

type member struct {
	key   string
	value node
}

// holdsBytes is whether the value is bytes or a list or a map that holds bytes at any depth.
func holdsBytes(n node) bool {
	if n.kind == "bytes_hex" {
		return true
	}
	for _, item := range n.items {
		if holdsBytes(item) {
			return true
		}
	}
	for _, m := range n.members {
		if holdsBytes(m.value) {
			return true
		}
	}
	return false
}

func (n node) String() string {
	switch n.kind {
	case "array":
		parts := make([]string, len(n.items))
		for i, item := range n.items {
			parts[i] = item.String()
		}
		return "[" + strings.Join(parts, ",") + "]"
	case "object":
		parts := make([]string, len(n.members))
		for i, m := range n.members {
			parts[i] = strconv.Quote(m.key) + ":" + m.value.String()
		}
		return "{" + strings.Join(parts, ",") + "}"
	case "nil":
		return "nil"
	}
	return n.kind + "(" + n.text + ")"
}

// sequenceNodes returns the int nodes of a {"sequence": {"from": N, "count": M}} wrapper (FCV-4), and whether raw is one.
func sequenceNodes(raw json.RawMessage) ([]node, bool, error) {
	var w map[string]json.RawMessage
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, false, fmt.Errorf("a recipe value is an object: %w", err)
	}
	body, ok := w["sequence"]
	if !ok {
		return nil, false, nil
	}
	if len(w) != 1 {
		return nil, true, fmt.Errorf("a sequence wrapper has the sequence key only: %s", raw)
	}
	var seq struct {
		From  int64 `json:"from"`
		Count int64 `json:"count"`
	}
	if err := json.Unmarshal(body, &seq); err != nil || seq.Count < 1 {
		return nil, true, fmt.Errorf("a sequence needs from and a count of at least 1: %s", body)
	}
	out := make([]node, 0, seq.Count)
	for i := int64(0); i < seq.Count; i++ {
		out = append(out, node{kind: "int", text: strconv.FormatInt(seq.From+i, 10)})
	}
	return out, true, nil
}

func wrapper(raw json.RawMessage) (node, error) {
	var w map[string]json.RawMessage
	if err := json.Unmarshal(raw, &w); err != nil || len(w) != 1 {
		return node{}, fmt.Errorf("a value is a wrapper with one key: %s", raw)
	}
	for kind, body := range w {
		switch kind {
		case "array":
			var items []json.RawMessage
			if err := json.Unmarshal(body, &items); err != nil {
				return node{}, err
			}
			n := node{kind: kind}
			for _, item := range items {
				// a sequence item adds its integers in place, so one array can hold several ranges (FCV-4).
				if seq, ok, err := sequenceNodes(item); err != nil {
					return node{}, err
				} else if ok {
					n.items = append(n.items, seq...)
					continue
				}
				child, err := wrapper(item)
				if err != nil {
					return node{}, err
				}
				n.items = append(n.items, child)
			}
			return n, nil
		case "sequence":
			nodes, _, err := sequenceNodes(raw)
			if err != nil {
				return node{}, err
			}
			return node{kind: "array", items: nodes}, nil
		case "object":
			var pairs [][2]json.RawMessage
			if err := json.Unmarshal(body, &pairs); err != nil {
				return node{}, err
			}
			n := node{kind: kind}
			for _, pair := range pairs {
				var k string
				if err := json.Unmarshal(pair[0], &k); err != nil {
					return node{}, err
				}
				child, err := wrapper(pair[1])
				if err != nil {
					return node{}, err
				}
				n.members = append(n.members, member{k, child})
			}
			return n, nil
		case "bool":
			var b bool
			if err := json.Unmarshal(body, &b); err != nil {
				return node{}, err
			}
			return node{kind: kind, text: strconv.FormatBool(b)}, nil
		case "nil":
			return node{kind: kind}, nil
		default:
			var text string
			if err := json.Unmarshal(body, &text); err != nil {
				return node{}, err
			}
			return node{kind: kind, text: text}, nil
		}
	}
	panic("unreachable")
}

// argument is the Go value of an argument: a ref to a bound result, or a wrapper.
func argument(raw json.RawMessage, bound map[string]result) (any, error) {
	if ref, ok, err := reference(raw, bound); ok || err != nil {
		return ref, err
	}
	n, err := wrapper(raw)
	if err != nil {
		return nil, err
	}
	return toGo(n)
}

func reference(raw json.RawMessage, bound map[string]result) (any, bool, error) {
	var ref struct {
		Ref *string `json:"ref"`
	}
	if err := json.Unmarshal(raw, &ref); err != nil {
		return nil, false, err
	}
	if ref.Ref == nil {
		return nil, false, nil
	}
	name, field, dotted := strings.Cut(*ref.Ref, ".")
	r, ok := bound[name]
	if !ok {
		return nil, true, fmt.Errorf("ref %s names no bound result", *ref.Ref)
	}
	if r.err != nil {
		return nil, true, fmt.Errorf("ref %s names a failed step: %w", *ref.Ref, r.err)
	}
	if dotted {
		// A dotted ref reads a field of the plain result of a step, such as the mermaid of an export (FCV-4).
		m, ok := r.cell.(map[string]any)
		if !ok {
			return nil, true, fmt.Errorf("ref %s: the result of %s has no fields", *ref.Ref, name)
		}
		v, ok := m[field]
		if !ok {
			return nil, true, fmt.Errorf("ref %s names no field", *ref.Ref)
		}
		return v, true, nil
	}
	if r.decoded {
		return r.styled, true, nil
	}
	return r.cell, true, nil
}

// styledArgument is the styled value an encode takes: SQL NULL for null, an ordered-json value for an ordered_json stage,
// orderedValue is the ordered-json value of a recipe value, with the member order and the number text of the recipe.
func orderedValue(n node) (orm.StyledValue, error) {
	text, err := jsonText(n)
	if err != nil {
		return orm.StyledValue{}, err
	}
	v, err := orderedjson.Parse(text)
	if err != nil {
		return orm.StyledValue{}, err
	}
	return orm.Value(v), nil
}

// so that its member order and number text are those of the recipe, and the common value model otherwise.
func styledArgument(raw json.RawMessage, styles []string, bound map[string]result) (orm.StyledValue, error) {
	if ref, ok, err := reference(raw, bound); ok || err != nil {
		if err != nil {
			return orm.StyledValue{}, err
		}
		if styled, isStyled := ref.(orm.StyledValue); isStyled {
			return styled, nil
		}
		return orm.Value(ref), nil
	}
	// An ordered_json wrapper is the ordered-json value of its value, whatever the stages (FCV-4).
	var probe map[string]json.RawMessage
	if json.Unmarshal(raw, &probe) == nil && len(probe) == 1 && probe["ordered_json"] != nil {
		inner, err := wrapper(probe["ordered_json"])
		if err != nil {
			return orm.StyledValue{}, err
		}
		return orderedValue(inner)
	}
	n, err := wrapper(raw)
	if err != nil {
		return orm.StyledValue{}, err
	}
	if n.kind == "null" {
		return orm.SqlNull(), nil
	}
	// Bytes have no JSON text, so a value that holds bytes reaches an ordered_json stage as the value it is (COD-63).
	if slices.Contains(styles, "ordered_json") && !holdsBytes(n) {
		return orderedValue(n)
	}
	v, err := toGo(n)
	if err != nil {
		return orm.StyledValue{}, err
	}
	return orm.Value(v), nil
}

// jsonText writes n as JSON text with its members in order and its numbers as their recipe text.
func jsonText(n node) (string, error) {
	switch n.kind {
	case "nil":
		return "null", nil
	case "bool", "int", "float":
		return n.text, nil
	case "text":
		b, err := json.Marshal(n.text)
		return string(b), err
	case "array":
		parts := make([]string, len(n.items))
		for i, item := range n.items {
			text, err := jsonText(item)
			if err != nil {
				return "", err
			}
			parts[i] = text
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	case "object":
		parts := make([]string, len(n.members))
		for i, m := range n.members {
			k, err := json.Marshal(m.key)
			if err != nil {
				return "", err
			}
			text, err := jsonText(m.value)
			if err != nil {
				return "", err
			}
			parts[i] = string(k) + ":" + text
		}
		return "{" + strings.Join(parts, ",") + "}", nil
	}
	return "", fmt.Errorf("the wrapper %s has no JSON text", n.kind)
}

// toGo is the Go value of a wrapper in the common value model of COD-16.
func toGo(n node) (any, error) {
	switch n.kind {
	case "nil", "null":
		return nil, nil
	case "bool":
		return n.text == "true", nil
	case "int":
		if i, err := strconv.ParseInt(n.text, 10, 64); err == nil {
			return i, nil
		}
		return strconv.ParseUint(n.text, 10, 64)
	case "float":
		return strconv.ParseFloat(n.text, 64)
	case "f64":
		switch n.text {
		case "NaN":
			return math.NaN(), nil
		case "Infinity":
			return math.Inf(1), nil
		case "-Infinity":
			return math.Inf(-1), nil
		}
		return nil, fmt.Errorf("an f64 wrapper is NaN, Infinity or -Infinity, not %q", n.text)
	case "text":
		return n.text, nil
	case "bytes_hex":
		return hex.DecodeString(n.text)
	case "array":
		out := make([]any, len(n.items))
		for i, item := range n.items {
			v, err := toGo(item)
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		return out, nil
	case "object":
		out := make(map[string]any, len(n.members))
		for _, m := range n.members {
			v, err := toGo(m.value)
			if err != nil {
				return nil, err
			}
			out[m.key] = v
		}
		return out, nil
	}
	return nil, fmt.Errorf("a %s wrapper is not a codec value", n.kind)
}

// fromGo is the tree of a decoded Go value; an ordered-json value keeps its member order and number text.
func fromGo(v any) (node, error) {
	switch x := v.(type) {
	case nil:
		return node{kind: "nil"}, nil
	case bool:
		return node{kind: "bool", text: strconv.FormatBool(x)}, nil
	case int64:
		return node{kind: "int", text: strconv.FormatInt(x, 10)}, nil
	case int:
		return node{kind: "int", text: strconv.Itoa(x)}, nil
	case uint64:
		return node{kind: "int", text: strconv.FormatUint(x, 10)}, nil
	case float64:
		return node{kind: "float", text: strconv.FormatFloat(x, 'g', -1, 64)}, nil
	case string:
		return node{kind: "text", text: x}, nil
	case []byte:
		return node{kind: "bytes_hex", text: hex.EncodeToString(x)}, nil
	case []any:
		n := node{kind: "array"}
		for _, item := range x {
			child, err := fromGo(item)
			if err != nil {
				return node{}, err
			}
			n.items = append(n.items, child)
		}
		return n, nil
	case map[string]any:
		n := node{kind: "object"}
		for k, item := range x {
			child, err := fromGo(item)
			if err != nil {
				return node{}, err
			}
			n.members = append(n.members, member{k, child})
		}
		return n, nil
	case *orderedjson.Value:
		return fromOrdered(x)
	}
	return node{}, fmt.Errorf("decoded value of type %T", v)
}

func fromOrdered(v *orderedjson.Value) (node, error) {
	switch v.Kind() {
	case orderedjson.NullKind:
		return node{kind: "nil"}, nil
	case orderedjson.BooleanKind:
		b, err := v.BooleanValue()
		return node{kind: "bool", text: strconv.FormatBool(b)}, err
	case orderedjson.StringKind:
		s, err := v.StringValue()
		return node{kind: "text", text: s}, err
	case orderedjson.NumberKind:
		text, err := v.NumberLiteral()
		if err != nil {
			return node{}, err
		}
		if strings.ContainsAny(text, ".eE") {
			return node{kind: "float", text: text}, nil
		}
		return node{kind: "int", text: text}, nil
	case orderedjson.ArrayKind:
		items, err := v.Items()
		if err != nil {
			return node{}, err
		}
		n := node{kind: "array"}
		for _, item := range items {
			child, err := fromOrdered(item)
			if err != nil {
				return node{}, err
			}
			n.items = append(n.items, child)
		}
		return n, nil
	case orderedjson.ObjectKind:
		members, err := v.Members()
		if err != nil {
			return node{}, err
		}
		n := node{kind: "object"}
		for _, k := range members.Keys() {
			name, err := k.StringValue()
			if err != nil {
				return node{}, err
			}
			child, err := fromOrdered(members.Get(name))
			if err != nil {
				return node{}, err
			}
			n.members = append(n.members, member{name, child})
		}
		return n, nil
	}
	return node{}, fmt.Errorf("ordered-json kind %s", v.Kind())
}

// equal compares a decoded tree with a wrapper: an ordered-json value by its number text and member order (COD-16), every
// other value by number value and with its object as a set of pairs, since no other style defines a member order (FCV-4).
func equal(got, want node, ordered bool) bool {
	if got.kind != want.kind {
		return false
	}
	switch got.kind {
	case "float":
		if ordered {
			return got.text == want.text
		}
		return sameFloat(got.text, want.text)
	case "int":
		if ordered {
			return got.text == want.text
		}
		a, okA := new(big.Int).SetString(got.text, 10)
		b, okB := new(big.Int).SetString(want.text, 10)
		return okA && okB && a.Cmp(b) == 0
	case "array":
		if len(got.items) != len(want.items) {
			return false
		}
		for i := range got.items {
			if !equal(got.items[i], want.items[i], ordered) {
				return false
			}
		}
		return true
	case "object":
		if len(got.members) != len(want.members) {
			return false
		}
		if ordered {
			for i := range got.members {
				if got.members[i].key != want.members[i].key || !equal(got.members[i].value, want.members[i].value, ordered) {
					return false
				}
			}
			return true
		}
		for _, w := range want.members {
			found := false
			for _, g := range got.members {
				if g.key == w.key && equal(g.value, w.value, ordered) {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
		return true
	}
	return got.text == want.text
}

// sameFloat reports whether two number texts name the same binary64 value (FCV-4).
func sameFloat(a, b string) bool {
	x, errA := strconv.ParseFloat(a, 64)
	y, errB := strconv.ParseFloat(b, 64)
	return errA == nil && errB == nil && (x == y || math.IsNaN(x) && math.IsNaN(y))
}

// validate passes a request of an ir.validate step to the validator of the protocol, with the manifest_hash of the schema
// added (the request holds none), as the native vector test did. Its literal numbers are kept as their JSON text.
func validate(m *runtimemodel.Model, raw json.RawMessage, manifestHash string) error {
	if m == nil {
		return fmt.Errorf("ir.validate needs the schema key of the recipe")
	}
	var request map[string]json.RawMessage
	if err := json.Unmarshal(raw, &request); err != nil {
		return err
	}
	if _, ok := request["manifest_hash"]; ok {
		return fmt.Errorf("request already holds manifest_hash")
	}
	if manifestHash == "" {
		manifestHash = m.ManifestHash
	}
	hash, err := json.Marshal(manifestHash)
	if err != nil {
		return err
	}
	request["manifest_hash"] = hash
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	_, err = ir.Decode(m, body)
	return err
}

// checkValidate compares the error of validate with the outcome of an expect: {value: bool true} for an accepted request,
// {error: CODE} for a request that fails with CODE (the error text starts with CODE and a colon).
func checkValidate(raw json.RawMessage, err error) error {
	var outcome struct {
		Value json.RawMessage `json:"value"`
		Error string          `json:"error"`
	}
	if e := json.Unmarshal(raw, &outcome); e != nil {
		return e
	}
	if outcome.Error != "" {
		if err == nil || !strings.HasPrefix(err.Error(), outcome.Error+":") {
			return fmt.Errorf("got %w, want %s", err, outcome.Error)
		}
		return nil
	}
	if string(outcome.Value) != `{"bool":true}` {
		return fmt.Errorf("ir.validate expects {bool true} or an error, got %s", outcome.Value)
	}
	if err != nil {
		return fmt.Errorf("unexpected error %w", err)
	}
	return nil
}

// checkAnswer runs the chain of an ir.answer step with fn and compares its result with the value of the expect of database.
// The result is normalized as a JSON value, an orm error becomes {"error": CODE}, and any other error fails the step.
func checkAnswer(t *testing.T, s step, database string, fn IRAnswer) error {
	if fn == nil {
		return fmt.Errorf("ir.answer needs the WithIRAnswer option of the test")
	}
	raw, ok := s.Expect[database]
	if !ok {
		return fmt.Errorf("ir.answer has no expect for %s", database)
	}
	var outcome struct {
		Value  json.RawMessage `json:"value"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(raw, &outcome); err != nil {
		return err
	}
	if outcome.Value == nil && outcome.Params == nil {
		return fmt.Errorf("ir.answer expect for %s has neither value nor params", database)
	}
	params := outcome.Params != nil
	want := outcome.Value
	if params {
		want = outcome.Params
	}
	var wantValue any
	if err := json.Unmarshal(want, &wantValue); err != nil {
		return err
	}
	got, err := fn(t, s.Chain, s.Answer, s.Answers, params)
	if err != nil {
		code := orm.ErrorCode(err)
		if code == "" {
			return fmt.Errorf("chain %s failed without an orm code: %w", s.Chain, err)
		}
		got = map[string]any{"error": code}
	}
	body, err := json.Marshal(got)
	if err != nil {
		return fmt.Errorf("chain %s result %#v: %w", s.Chain, got, err)
	}
	var actual any
	if err := json.Unmarshal(body, &actual); err != nil {
		return err
	}
	if !reflect.DeepEqual(actual, wantValue) {
		return fmt.Errorf("chain %s: got %s, want %s", s.Chain, body, want)
	}
	return nil
}

// plannerDialects are the dialects that a planner.compile step compiles its request for, in the order of the planner fixture.
var plannerDialects = []string{"mysql", "postgres", "sqlite"}

// plannerStatement is the role, SQL, bind slot, and table of one compiled plan step, as the planner fixture writes it.
type plannerStatement struct {
	Role   string        `json:"role"`
	SQL    string        `json:"sql"`
	Slots  []plannerSlot `json:"slots"`
	Tables []string      `json:"tables"`
	// AssembleTypes is the type of each output column of the step, by name, when the step asks for it.
	AssembleTypes map[string]string `json:"assemble_types,omitempty"`
}

// plannerSlot is the source and type of one bind slot. A param slot carries the request value's number, a parent slot
// carries the key's type, and the other slots carry a type.
type plannerSlot struct {
	From  string `json:"from"`
	Param *int   `json:"param,omitempty"`
	Type  string `json:"type,omitempty"`
	// Precision is the fraction digits of a datetime or time slot.
	Precision *int `json:"precision,omitempty"`
	// Length is the n of a varchar(n) param slot.
	Length *int `json:"length,omitempty"`
	// NotNull marks a param slot that assigns a non-null column.
	NotNull  bool     `json:"not_null,omitempty"`
	KeyTypes []string `json:"key_types,omitempty"`
	// Name is the audit record table of an audit slot (PRT-32).
	Name string `json:"name,omitempty"`
}

// checkPlanner compiles the request of a planner.compile step with the engine of each dialect, against the manifest of the
// schema that the step names relative to dir, and compares the plans with the expect of database: {value: {mysql, postgres,
// sqlite}} with the statements of each dialect, or {error: CODE}, which every dialect must fail with.
// plannerRequest is the model of the schema of a planner step and the JSON of its input with the manifest_hash of that schema.
func plannerRequest(dir string, s step) (*runtimemodel.Model, []byte, error) {
	m, err := runtimemodel.LoadFiles(filepath.Join(dir, s.Schema))
	if err != nil {
		return nil, nil, err
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal(s.Input, &input); err != nil {
		return nil, nil, err
	}
	hash, err := json.Marshal(m.ManifestHash)
	if err != nil {
		return nil, nil, err
	}
	input["manifest_hash"] = hash
	request, err := json.Marshal(input)
	return m, request, err
}

// checkParamUses states the uses of each parameter of a validated request, the slot form that a markdown connection
// reads for it (DIA-31, PRT-67): {uses: [[{type} or {type, assign, column, length, null, precision, scale}]]}.
func checkParamUses(dir string, s step, database string) error {
	var outcome struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(s.Expect[database], &outcome); err != nil {
		return err
	}
	m, body, err := plannerRequest(dir, s)
	if err != nil {
		return err
	}
	request, err := ir.Decode(m, body)
	if err != nil {
		return err
	}
	uses, err := ir.ParamUses(m, request)
	if err != nil {
		return err
	}
	list := []any{}
	for _, parameter := range uses {
		entries := []any{}
		for _, use := range parameter {
			entry := map[string]any{"type": use.Type}
			if f := use.Column; f != nil {
				entry["column"], entry["length"], entry["null"], entry["precision"], entry["scale"] = f.Name, f.Length, f.Null, f.Precision, f.Scale
				if use.Assign {
					entry["assign"] = true
				}
			}
			entries = append(entries, entry)
		}
		list = append(list, entries)
	}
	return sameJSON("ir.param_uses", map[string]any{"uses": list}, outcome.Value)
}

// checkPlannerColumns states the output columns that the names of the step select from the first statement of the plan
// of each dialect: their type and whether they are hidden (PRT-69, DIA-33).
func checkPlannerColumns(dir string, s step, database string) error {
	var outcome struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(s.Expect[database], &outcome); err != nil {
		return err
	}
	m, request, err := plannerRequest(dir, s)
	if err != nil {
		return err
	}
	for _, dialect := range plannerDialects {
		e, err := engine.New(m, dialect)
		if err != nil {
			return err
		}
		out, err := e.Compile(request)
		if err != nil {
			return fmt.Errorf("%s: %w", dialect, err)
		}
		var compiled plan.Plan
		if err := json.Unmarshal(out, &compiled); err != nil {
			return err
		}
		assemble := compiled.Steps[0].Assemble
		got := []any{}
		for _, name := range s.Names {
			for _, column := range assemble.Columns {
				if column.Name == name {
					got = append(got, map[string]any{"name": name, "type": column.Type, "hidden": column.Hidden})
				}
			}
		}
		if err := sameJSON("planner.columns "+dialect, got, outcome.Value); err != nil {
			return err
		}
	}
	return nil
}

// sameJSON compares a value with the JSON of an expect, whatever the order of their keys.
func sameJSON(what string, got any, want json.RawMessage) error {
	body, err := json.Marshal(got)
	if err != nil {
		return err
	}
	var actual, expected any
	if err := json.Unmarshal(body, &actual); err != nil {
		return err
	}
	if err := json.Unmarshal(want, &expected); err != nil {
		return err
	}
	if !reflect.DeepEqual(actual, expected) {
		return fmt.Errorf("%s: got %s, want %s", what, body, want)
	}
	return nil
}

func checkPlanner(dir string, s step, database string) error {
	if database != None {
		return fmt.Errorf("planner.compile runs without a database")
	}
	if s.Schema == "" {
		return fmt.Errorf("planner.compile needs a schema")
	}
	raw, ok := s.Expect[database]
	if !ok {
		return fmt.Errorf("planner.compile has no expect for %s", database)
	}
	var outcome struct {
		Value   json.RawMessage `json:"value"`
		Error   string          `json:"error"`
		Message string          `json:"message"`
	}
	if err := json.Unmarshal(raw, &outcome); err != nil {
		return err
	}
	m, err := runtimemodel.LoadFiles(filepath.Join(dir, s.Schema))
	if err != nil {
		return err
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal(s.Input, &input); err != nil {
		return err
	}
	if _, ok := input["manifest_hash"]; ok {
		return fmt.Errorf("input already holds manifest_hash")
	}
	hash, err := json.Marshal(m.ManifestHash)
	if err != nil {
		return err
	}
	input["manifest_hash"] = hash
	request, err := json.Marshal(input)
	if err != nil {
		return err
	}
	if outcome.Error != "" {
		for _, dialect := range plannerDialects {
			e, err := engine.New(m, dialect)
			if err != nil {
				return err
			}
			_, err = e.Compile(request)
			if err == nil || orm.ErrorCode(err) != outcome.Error {
				return fmt.Errorf("%s: compile = %w; want %s", dialect, err, outcome.Error)
			}
			if outcome.Message != "" && err.Error() != outcome.Message {
				return fmt.Errorf("%s: message %q, want %q", dialect, err.Error(), outcome.Message)
			}
		}
		return nil
	}
	got := map[string]any{}
	for _, dialect := range plannerDialects {
		e, err := engine.New(m, dialect)
		if err != nil {
			return err
		}
		out, err := e.Compile(request)
		if err != nil {
			return fmt.Errorf("%s: %w", dialect, err)
		}
		var compiled plan.Plan
		if err := json.Unmarshal(out, &compiled); err != nil {
			return err
		}
		statements := plannerStatements(compiled)
		if s.AssembleTypes {
			for i, step := range compiled.Steps {
				statements[i].AssembleTypes = map[string]string{}
				for _, column := range step.Assemble.Columns {
					statements[i].AssembleTypes[column.Name] = column.Type
				}
			}
		}
		got[dialect] = statements
	}
	body, err := json.Marshal(got)
	if err != nil {
		return err
	}
	var actual, want any
	if err := json.Unmarshal(body, &actual); err != nil {
		return err
	}
	if err := json.Unmarshal(outcome.Value, &want); err != nil {
		return err
	}
	if !reflect.DeepEqual(actual, want) {
		return fmt.Errorf("planner.compile: got %s, want %s", body, outcome.Value)
	}
	return nil
}

// plannerStatements converts the steps of a compiled plan to the statements of the planner fixture.
func plannerStatements(compiled plan.Plan) []plannerStatement {
	got := []plannerStatement{}
	for _, step := range compiled.Steps {
		slots := []plannerSlot{}
		for _, slot := range step.BindSlots {
			s := plannerSlot{From: slot.From}
			switch slot.From {
			case "param":
				s.Param, s.Type = &slot.Param, slot.ColType
			case "parent":
				s.KeyTypes = slot.KeyTypes
			default:
				s.Type = slot.ColType
			}
			if slot.From == "audit" {
				s.Name = slot.Name
			}
			if slot.ColType == "datetime" || slot.ColType == "time" {
				precision := slot.Precision
				s.Precision = &precision
			}
			s.NotNull = slot.NotNull
			if slot.From == "param" && slot.ColType == "varchar" {
				length := slot.Length
				s.Length = &length
			}
			slots = append(slots, s)
		}
		got = append(got, plannerStatement{Role: step.Role, SQL: step.SQL, Slots: slots, Tables: step.Tables})
	}
	return got
}

// dbspecStep runs one dbspec op of a recipe without a database, through the public calls of engine/dbspec (FCV-4), and
// compares what the call returned, as JSON, with the expect of database.
func dbspecStep(s step, bound map[string]result, database string) error {
	want, ok := s.Expect[database]
	if !ok {
		return fmt.Errorf("%s has no expect for %s", s.Op, database)
	}
	var got any
	var err error
	switch s.Op {
	case "dbspec.parse", "dbspec.parse_plan":
		got, err = dbspecParse(s, bound)
	case "dbspec.emit_plan":
		got, err = dbspecEmitPlan(s, bound)
	case "dbspec.diff":
		got, err = dbspecDiff(s, bound)
	case "dbspec.plan_steps":
		got, err = dbspecPlanSteps(s, bound)
	case "dbspec.add_tables_steps":
		got, err = dbspecAddTablesSteps(s, bound)
	case "dbspec.chain":
		got, err = dbspecChain(s, bound)
	case "dbspec.compare":
		got, err = dbspecCompare(s, bound)
	default:
		return fmt.Errorf("OP_UNKNOWN %s", s.Op)
	}
	if err != nil {
		return err
	}
	body, err := json.Marshal(got)
	if err != nil {
		return err
	}
	var actual, expected any
	if err := json.Unmarshal(body, &actual); err != nil {
		return err
	}
	if err := json.Unmarshal(want, &expected); err != nil {
		return err
	}
	if !reflect.DeepEqual(actual, expected) {
		return fmt.Errorf("%s: got %s, want %s", s.Op, body, want)
	}
	return nil
}

// dbspecParse runs dbspec.parse (Parse) or dbspec.parse_plan (ParsePlan) on the lines of s, binds the result to s.As, and
// returns {diagnostics: rows} with the rows of the diagnostics (parseRows).
func dbspecParse(s step, bound map[string]result) (any, error) {
	text := strings.Join(s.Lines, "\n") + "\n"
	var diagnostics []dbspec.Diagnostic
	if s.Op == "dbspec.parse" {
		doc, _, d := dbspec.Parse(text, nil)
		diagnostics = d
		if s.As != "" {
			bound[s.As] = result{dbspec: doc}
		}
	} else {
		p, d := dbspec.ParsePlan(text)
		diagnostics = d
		if s.As != "" {
			bound[s.As] = result{dbspec: p}
		}
	}
	return map[string]any{"diagnostics": parseRows(diagnostics, false)}, nil
}

// dbspecEmitPlan runs dbspec.emit_plan (EmitPlan) on the plan that s names and returns {text: the emitted plan}.
func dbspecEmitPlan(s step, bound map[string]result) (any, error) {
	p, err := dbspecPlan(s.Plan, bound)
	if err != nil {
		return nil, err
	}
	return map[string]any{"text": dbspec.EmitPlan(p)}, nil
}

// dbspecPlanSteps runs dbspec.plan_steps (PlanSteps) on the source and plan that s names, for the dialect of s, and returns
// {steps: rows} (planStepFields) or, with diagnostics, {messages: ...} of rule plan.
func dbspecPlanSteps(s step, bound map[string]result) (any, error) {
	source, plan, err := sourceAndPlan(s, bound)
	if err != nil {
		return nil, err
	}
	dialect := dbspec.Dialect(s.Dialect)
	if !knownDialect(dialect) {
		return dialectRefusal(s.Dialect, func() { dbspec.PlanSteps(source, plan, dialect) })
	}
	steps, diagnostics := dbspec.PlanSteps(source, plan, dialect)
	if len(diagnostics) > 0 {
		messages, err := messagesOf(diagnostics, dbspec.RulePlan)
		return map[string]any{"messages": messages}, err
	}
	rows := make([]map[string]any, 0, len(steps))
	for _, st := range steps {
		rows = append(rows, planStepFields(st))
	}
	return map[string]any{"steps": rows}, nil
}

// dbspecAddTablesSteps runs dbspec.add_tables_steps (AddTablesAndColumnsSteps) on the source and target that s names, with no
// unsupported items, for the dialect of s, and returns {added, statements, differences}.
func dbspecAddTablesSteps(s step, bound map[string]result) (any, error) {
	source, err := dbspecDocument(s.Source, bound)
	if err != nil {
		return nil, err
	}
	target, err := dbspecDocument(s.Target, bound)
	if err != nil {
		return nil, err
	}
	added, steps, differences := dbspec.AddTablesAndColumnsSteps(source, nil, target, dbspec.Dialect(s.Dialect))
	statements := make([]string, 0, len(steps))
	for _, st := range steps {
		statements = append(statements, st.Statement)
	}
	return map[string]any{"added": append([]string{}, added...), "statements": statements, "differences": append([]string{}, differences...)}, nil
}

// knownDialect reports whether d is one of the three dialects.
func knownDialect(d dbspec.Dialect) bool {
	return d == dbspec.DialectMySQL || d == dbspec.DialectPostgres || d == dbspec.DialectSQLite
}

// dialectRefusal runs a call that takes the dialect name and returns {refused: name} when the call panics with a message
// that names it (DBS-174); a call that returns is an error, because it accepted the dialect.
func dialectRefusal(name string, call func()) (got any, err error) {
	defer func() {
		recovered := recover()
		switch {
		case recovered == nil:
			err = fmt.Errorf("the call accepted the dialect %q", name)
		case !strings.Contains(fmt.Sprint(recovered), name):
			err = fmt.Errorf("the refusal %v does not name %q", recovered, name)
		default:
			got = map[string]any{"refused": name}
		}
	}()
	call()
	return nil, nil
}

// planStepFields is the object of a plan step (docs/spec/plans.md "Steps"): its statement, its effect as text, and the
// fields that the step has.
func planStepFields(s dbspec.PlanStep) map[string]any {
	out := map[string]any{"statement": s.Statement, "effect": s.Effect.String()}
	switch {
	case s.Rollback != "":
		out["rollback"] = s.Rollback
	case s.Irreversible != "":
		out["irreversible"] = s.Irreversible
	}
	if s.Restore != "" {
		out["restore"] = s.Restore
	}
	if s.RollbackRestore != "" {
		out["rollback_restore"] = s.RollbackRestore
	}
	if s.Restore != "" || s.RollbackRestore != "" {
		out["restore_if"] = s.RestoreIf.String()
	}
	if len(s.NullChecks) > 0 {
		checks := make([]any, 0, len(s.NullChecks))
		for _, c := range s.NullChecks {
			var def any
			if c.HasDefault {
				def = c.Default
			}
			checks = append(checks, []any{c.Table, c.Column, def})
		}
		out["null_checks"] = checks
	}
	if s.Finalize {
		out["finalize"] = true
	}
	return out
}

// dbspecDiff runs dbspec.diff (Diff) and returns {changes: rows} or, with diagnostics, {messages: ...} of rule plan.
func dbspecDiff(s step, bound map[string]result) (any, error) {
	source, plan, err := sourceAndPlan(s, bound)
	if err != nil {
		return nil, err
	}
	changes, diagnostics := dbspec.Diff(source, plan)
	if len(diagnostics) > 0 {
		messages, err := messagesOf(diagnostics, dbspec.RulePlan)
		return map[string]any{"messages": messages}, err
	}
	rows := make([][]string, 0, len(changes))
	for _, c := range changes {
		rows = append(rows, []string{c.Kind, c.Table, c.Name})
	}
	return map[string]any{"changes": rows}, nil
}

// dbspecChain runs dbspec.chain (Chain) and returns {order: plan names} or, with diagnostics, {messages: ...} of rule chain.
func dbspecChain(s step, bound map[string]result) (any, error) {
	plans := make([]*dbspec.Plan, 0, len(s.Plans))
	for _, raw := range s.Plans {
		p, err := dbspecPlan(raw, bound)
		if err != nil {
			return nil, err
		}
		plans = append(plans, p)
	}
	chain, diagnostics := dbspec.Chain(plans)
	if len(diagnostics) > 0 {
		messages, err := messagesOf(diagnostics, dbspec.RuleChain)
		return map[string]any{"messages": messages}, err
	}
	order := make([]string, 0, len(chain))
	for _, p := range chain {
		order = append(order, p.Name)
	}
	return map[string]any{"order": order}, nil
}

// dbspecCompare runs dbspec.compare (CompareSchemas) and returns {differences: rows, diagnostics: rows}, whose diagnostics
// carry their message for every rule.
func dbspecCompare(s step, bound map[string]result) (any, error) {
	source, err := dbspecDocument(s.Source, bound)
	if err != nil {
		return nil, err
	}
	target, err := dbspecDocument(s.Target, bound)
	if err != nil {
		return nil, err
	}
	differences, diagnostics := dbspec.CompareSchemas(source, target)
	rows := make([][]string, 0, len(differences))
	for _, d := range differences {
		rows = append(rows, []string{d.Kind, d.Table, d.Name})
	}
	return map[string]any{"differences": rows, "diagnostics": parseRows(diagnostics, true)}, nil
}

// parseRows are the diagnostics as [rule, line, column, message]: the message is that of rule plan only, unless all is set.
func parseRows(diagnostics []dbspec.Diagnostic, all bool) [][]any {
	rows := make([][]any, 0, len(diagnostics))
	for _, d := range diagnostics {
		var message any
		if all || d.Rule == dbspec.RulePlan {
			message = d.Message
		}
		rows = append(rows, []any{d.Rule, d.Line, d.Column, message})
	}
	return rows
}

// messagesOf returns the messages of diagnostics, each of rule, and fails on a diagnostic of another rule.
func messagesOf(diagnostics []dbspec.Diagnostic, rule string) ([]string, error) {
	messages := make([]string, 0, len(diagnostics))
	for _, d := range diagnostics {
		if d.Rule != rule {
			return nil, fmt.Errorf("diagnostic of rule %s, want %s: %s", d.Rule, rule, d.Message)
		}
		messages = append(messages, d.Message)
	}
	return messages, nil
}

// dbspecRef is the bound result that a ref names.
func dbspecRef(raw json.RawMessage, bound map[string]result) (any, error) {
	var ref struct {
		Ref *string `json:"ref"`
	}
	if err := json.Unmarshal(raw, &ref); err != nil {
		return nil, err
	}
	if ref.Ref == nil {
		return nil, fmt.Errorf("%s is not a ref", raw)
	}
	r, ok := bound[*ref.Ref]
	if !ok {
		return nil, fmt.Errorf("ref %s names no bound result", *ref.Ref)
	}
	return r.dbspec, nil
}

// readRecipe reads the recipe at path into a T, after the key check of its file (T334-3-5-6); a read, a key or a JSON error
// fails t.
func readRecipe[T any](t *testing.T, path string) T {
	t.Helper()
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := checkKeys(path, src); err != nil {
		t.Fatal(err)
	}
	var f T
	if err := json.Unmarshal(src, &f); err != nil {
		t.Fatalf("recipe %s: %v", path, err)
	}
	return f
}

// sourceAndPlan reads the source document and the plan that s names.
func sourceAndPlan(s step, bound map[string]result) (*dbspec.Document, *dbspec.Plan, error) {
	source, err := dbspecDocument(s.Source, bound)
	if err != nil {
		return nil, nil, err
	}
	plan, err := dbspecPlan(s.Plan, bound)
	return source, plan, err
}

// dbspecDocument is the document that a source or target names; null is the empty schema (nil).
func dbspecDocument(raw json.RawMessage, bound map[string]result) (*dbspec.Document, error) {
	if string(raw) == "null" {
		return nil, nil
	}
	value, err := dbspecRef(raw, bound)
	if err != nil {
		return nil, err
	}
	doc, ok := value.(*dbspec.Document)
	if !ok {
		return nil, fmt.Errorf("%s binds no document", raw)
	}
	return doc, nil
}

// dbspecPlan is the plan that a ref names.
func dbspecPlan(raw json.RawMessage, bound map[string]result) (*dbspec.Plan, error) {
	value, err := dbspecRef(raw, bound)
	if err != nil {
		return nil, err
	}
	p, ok := value.(*dbspec.Plan)
	if !ok || p == nil {
		return nil, fmt.Errorf("%s binds no plan", raw)
	}
	return p, nil
}

// checkSend runs a markdown.send step and checks its expect: {"message": <json>} against the first message the listener received,
// or {"error": <code>} against the code of the error the call returned before it sent a message. The expect is not per database.
func checkSend(t *testing.T, s step, fn MarkdownSend) error {
	if fn == nil {
		return fmt.Errorf("markdown.send needs WithMarkdownSend")
	}
	var begin *bool
	if s.Begin != nil {
		var b struct {
			ReadOnly bool `json:"read_only"`
		}
		if err := json.Unmarshal(s.Begin, &b); err != nil {
			return err
		}
		begin = &b.ReadOnly
	}
	message, code := fn(t, s.Column, s.Operator, s.Params, begin, s.Surface, s.ProcessZone)
	return checkMessage(s.Expect, message, code)
}

// checkBuilder runs one markdown.builder step and compares the code and the text of its error with the expect of database (FCV-4).
func checkBuilder(t *testing.T, s step, database string, fn MarkdownBuilder) error {
	if fn == nil {
		return fmt.Errorf("markdown.builder needs WithMarkdownBuilder")
	}
	var want struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(s.Expect[database], &want); err != nil {
		return err
	}
	code, message := fn(t, s.Calls)
	if code != want.Error || message != want.Message {
		return fmt.Errorf("the terminal returned %q %q, want %q %q", code, message, want.Error, want.Message)
	}
	return nil
}

// checkIntrospectSQLite runs one dbspec.introspect_sqlite step: the statements on a memory SQLite connection of its own, then the
// public Introspect, whose unsupported objects it compares with the expect of database (DIA-191).
func checkIntrospectSQLite(t *testing.T, s step, database string) error {
	var want struct {
		Unsupported []dbspec.Unsupported `json:"unsupported"`
	}
	if err := json.Unmarshal(s.Expect[database], &want); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return err
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close the memory SQLite connection: %v", err)
		}
	}()
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	for _, statement := range s.SQL {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	_, unsupported, err := dbspec.Introspect(ctx, db, dbspec.DialectSQLite, "introspected")
	if err != nil {
		return err
	}
	if !slices.Equal(unsupported, want.Unsupported) {
		return fmt.Errorf("unsupported objects = %+v, want %+v", unsupported, want.Unsupported)
	}
	return nil
}

// checkKeyring runs one keyring.versions step: the public constructor of the keyring, then its current version and its versions
// (INT-74, INT-130), against the expect of database.
func checkKeyring(s step, database string) error {
	var want struct {
		Current  int32   `json:"current"`
		Versions []int32 `json:"versions"`
		Error    string  `json:"error"`
	}
	if err := json.Unmarshal(s.Expect[database], &want); err != nil {
		return err
	}
	keyring, err := s.Keyring.keyring()
	if want.Error != "" {
		if code := orm.ErrorCode(err); code != want.Error {
			return fmt.Errorf("the keyring returned %v, want %s", err, want.Error)
		}
		return nil
	}
	if err != nil {
		return err
	}
	if got := keyring.CurrentAESVersion(); got != want.Current {
		return fmt.Errorf("current version %d, want %d", got, want.Current)
	}
	if got := keyring.AESVersions(); !slices.Equal(got, want.Versions) {
		return fmt.Errorf("versions %v, want %v", got, want.Versions)
	}
	return nil
}

// checkAssign runs one model.assign step and checks its expect against the message or the error it returns.
func checkAssign(t *testing.T, s step, fn ModelAssign) error {
	if fn == nil {
		return fmt.Errorf("model.assign needs WithModelAssign")
	}
	message, code := fn(t, s.Model, s.Column, s.Value)
	return checkMessage(s.Expect, message, code)
}

// checkMessage checks the message or the code of an error of a markdown listener step against its expect, {"message": JSON}
// or {"error": CODE}.
func checkMessage(expect map[string]json.RawMessage, message json.RawMessage, code string) error {
	if raw, ok := expect["error"]; ok {
		var want string
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		if code != want {
			return fmt.Errorf("the call returned error %q, want %q (message %s)", code, want, message)
		}
		return nil
	}
	raw, ok := expect["message"]
	if !ok {
		return fmt.Errorf("the step expects a message or an error")
	}
	if code != "" {
		return fmt.Errorf("the call returned error %s before a message", code)
	}
	var got, want any
	if err := json.Unmarshal(message, &got); err != nil {
		return fmt.Errorf("the message %s is not JSON: %w", message, err)
	}
	if err := json.Unmarshal(raw, &want); err != nil {
		return err
	}
	if !reflect.DeepEqual(got, want) {
		return fmt.Errorf("message %s, want %s", message, raw)
	}
	return nil
}

// collectionKey is one value of a collection.key step, in the form of its type.
type collectionKey struct {
	Type  string          `json:"type"`
	Value json.RawMessage `json:"value"`
	Hex   string          `json:"hex"`
}

// nativeKey is the value that a client reads from a column of the type of k.
func (k collectionKey) nativeKey() (any, error) {
	switch k.Type {
	case "null":
		return nil, nil
	case "bytes":
		return hex.DecodeString(k.Hex)
	case "int":
		var value int64
		return value, json.Unmarshal(k.Value, &value)
	case "bool":
		var value bool
		return value, json.Unmarshal(k.Value, &value)
	}
	var text string
	if err := json.Unmarshal(k.Value, &text); err != nil {
		return nil, err
	}
	if k.Type == "datetime" {
		return time.Parse(time.RFC3339Nano, text)
	}
	return text, nil
}

// sameKey reports that a key returned the value it took: the same instant of a time, the same value of any other type.
func sameKey(got, want any) bool {
	if instant, ok := got.(time.Time); ok {
		other, isTime := want.(time.Time)
		return isTime && instant.Equal(other)
	}
	return reflect.DeepEqual(got, want)
}

// keyTypeName names the native type of the value of a key.
func keyTypeName(value any) string {
	switch value.(type) {
	case string:
		return "text"
	case bool:
		return "bool"
	case int64:
		return "int"
	case []byte:
		return "bytes"
	case time.Time:
		return "datetime"
	}
	return fmt.Sprintf("%T", value)
}

// checkCollectionKey runs a collection.key step: each value through the public KeyOf. Its groups are, for each key, the index of the
// first key equal to it, and its types the native type of the value that the key returns (INT-11, INT-63, PRT-35).
func checkCollectionKey(s step, database string) error {
	groups, types := []int{}, []string{}
	keys := []orm.Key{}
	var failure error
	for _, entry := range s.Keys {
		value, err := entry.nativeKey()
		if err != nil {
			return err
		}
		key, err := orm.KeyOf(value)
		if err != nil {
			failure = err
			break
		}
		native, err := key.Value()
		if err != nil {
			return err
		}
		if !sameKey(native, value) {
			return fmt.Errorf("key %v changed its native value to %v", value, native)
		}
		group := len(keys)
		for index, other := range keys {
			if other == key {
				group = groups[index]
				break
			}
		}
		keys = append(keys, key)
		groups = append(groups, group)
		types = append(types, keyTypeName(native))
	}
	got := map[string]any{"groups": groups, "types": types}
	if failure != nil {
		got = map[string]any{"error": orm.ErrorCode(failure), "message": failure.Error()}
	}
	return sameKeyResult(got, s.Expect[database])
}

// sameKeyResult compares the result of a collection.key step with its expect, as JSON values.
func sameKeyResult(got map[string]any, expect json.RawMessage) error {
	gotText, err := json.Marshal(got)
	if err != nil {
		return err
	}
	var gotValue, wantValue any
	if err := json.Unmarshal(gotText, &gotValue); err != nil {
		return err
	}
	if err := json.Unmarshal(expect, &wantValue); err != nil {
		return err
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		return fmt.Errorf("got %s, want %s", gotText, expect)
	}
	return nil
}
