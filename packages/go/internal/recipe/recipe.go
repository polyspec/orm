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
	"errors"
	"fmt"
	"math"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
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
	// reads records the keys that the run reads (FCV-4).
	reads    *stepReads
	Op       string                     `json:"op"`
	GenSet   string                     `json:"document_set"`
	Same     []string                   `json:"unchanged"`
	Diff     []string                   `json:"changed"`
	Gone     []string                   `json:"removed"`
	Tree     map[string]json.RawMessage `json:"files"`
	Parts    []string                   `json:"parts"`
	FreeTail bool                       `json:"free_tail"`
	Compare  bool                       `json:"check"`
	Keys     []collectionKey            `json:"keys"`
	Styles   []string                   `json:"styles"`
	Raw      json.RawMessage            `json:"raw"`
	Value    json.RawMessage            `json:"value"`
	Key      *string                    `json:"key"`
	As       string                     `json:"as"`
	Request  json.RawMessage            `json:"request"`
	DSN      string                     `json:"dsn"`
	Config   dsnConfig                  `json:"config"`
	Schema   string                     `json:"schema"`
	Input    json.RawMessage            `json:"input"`
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
	// Server is the server that dbspec.introspect_refusal passes with Dialect; without it the call passes the dialect's name.
	Server string `json:"server"`
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
	Name     string `json:"name"`
	Corpus   string `json:"corpus"`
	Token    string `json:"token"`
	Reply    string `json:"reply"`
	Received string `json:"received"`
	// Replies and Messages are the fields of markdown.session: the lines the listener answers and the lines it must receive.
	Replies     []string                   `json:"replies"`
	Messages    []string                   `json:"messages"`
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
	// SetTree is the file tree of dbspec.read_set and SetFile the path of its set file in that tree.
	SetTree map[string]setTreeEntry `json:"tree"`
	SetFile string                  `json:"set_file"`
	// Keyring is the keyring of keyring.versions, Calls the builder calls of markdown.builder (FCV-4).
	Keyring *aesKeyringSpec `json:"keyring"`
	Calls   []string        `json:"calls"`
}

// MarkdownSend runs one markdown.send step on a markdown connection to a listener that records the first message it receives,
// and returns that message (the JSON of the message, or of the parameter of a statement) and the whole text of the error that
// the public call returned before it sent one, its code first (PRT-32a). A begin step passes begin, the statement passes column, operator and params.
// A non-empty processZone is the IANA zone name that is the process default zone while the step runs.
// It is supplied by the test package that owns the listener and the generated bind models, since they cannot be reached from here.
type MarkdownSend func(t *testing.T, column, operator string, params []json.RawMessage, begin *bool, processZone string) (message json.RawMessage, failure string)

// MarkdownBuilder runs one markdown.builder step: the builder calls on the generated model of the bind fixture, then its count
// terminal, on a listener that records a message. It returns the code and the text of the error of the terminal, and fails the test
// when a message reached the listener. It is supplied by the test package that owns the listener and the generated bind models.
type MarkdownBuilder func(t *testing.T, calls []string) (code, message string)

// MarkdownRead is the read of the markdown.session calls read and read_twice: Connect opens a connection with the generated
// bind models, and Read runs one public query of the bind fixture model on it. It is supplied by the test package that owns
// the generated bind models.
type MarkdownRead struct {
	Connect func(dsn string, cfg orm.Config) (*orm.DB, error)
	Read    func(db *orm.DB) error
}

// Option configures Run.
type Option func(*options)

// ModelAssign runs one model.assign step: it sets column of a new row of the generated model model through its public setter
// with value, builds the insert statement without a database, and returns the JSON of its one parameter or the code of the
// error that the setter or the encode returns before it sends a message. It is supplied by the test package that owns the models.
type ModelAssign func(t *testing.T, model, column string, value json.RawMessage) (json.RawMessage, string)

type options struct {
	// dir is the directory of the recipe file, which the dbspec ops resolve their documents against.
	dir             string
	markdownSend    MarkdownSend
	modelAssign     ModelAssign
	markdownBuilder MarkdownBuilder
	markdownRead    MarkdownRead
}

// WithMarkdownRead supplies the read of the markdown.session calls read and read_twice.
func WithMarkdownRead(read MarkdownRead) Option {
	return func(o *options) { o.markdownRead = read }
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
// the ops that need a function from the test, such as WithMarkdownSend.
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
				s.reads = newStepReads(raw)
				err := run(t, s, bound, database, model, o)
				if err == nil {
					err = s.reads.check()
				}
				if err != nil {
					t.Fatalf("recipe %s case %s step %d (%s) on %s: %v", path, c.ID, index, s.k("op").Op, database, err)
				}
			}
			reportCase(t, c.ID, database)
		})
	}
}

// run maps the op of s to its call and checks the result against the expect of database.
func run(t *testing.T, s step, bound map[string]result, database string, model *runtimemodel.Model, o options) error {
	switch s.k("op").Op {
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
	case "dbspec.parse", "dbspec.parse_plan", "dbspec.emit_plan", "dbspec.diff", "dbspec.plan_steps", "dbspec.introspect_refusal", "dbspec.add_tables_steps", "dbspec.chain", "dbspec.compare":
		return dbspecStep(s, bound, database)
	case "dbspec.parse_emit", "dbspec.manifest", "dbspec.render", "dbspec.analyze", "dbspec.parse_positions", "dbspec.format",
		"dbspec.parse_set", "dbspec.set", "dbspec.load_set", "dbspec.runtime_model", "dbspec.read_file", "dbspec.read_bytes":
		return checkDBSpec(s, o.dir, database)
	case "dbspec.read_set":
		return checkReadSet(s, database)
	case "dbspec.render_statements":
		return renderStatements(s, o.dir)
	case "dbspec.export_mermaid", "dbspec.import_mermaid":
		got, err := mermaidStep(s, bound, o.dir)
		if err != nil {
			return err
		}
		if s.k("as").As != "" {
			bound[s.k("as").As] = result{cell: got}
		}
		expect, ok := s.k("expect").Expect[database]
		if !ok {
			return fmt.Errorf("%s has no expect for %s", s.k("op").Op, database)
		}
		return checkMermaid(expect, got)
	}
	if s.k("op").Op == "ir.validate" {
		return checkValidate(s.k("expect").Expect[database], validate(model, s.k("request").Request, s.k("manifest_hash").ManifestHash))
	}
	if s.k("op").Op == "markdown.send" {
		return checkSend(t, s, o.markdownSend)
	}
	if s.k("op").Op == "model.assign" {
		return checkAssign(t, s, o.modelAssign)
	}
	if s.k("op").Op == "collection.key" {
		return checkCollectionKey(s, database)
	}
	if s.k("op").Op == "markdown.builder" {
		return checkBuilder(t, s, database, o.markdownBuilder)
	}
	if s.k("op").Op == "interface.symbols" {
		return checkInterfaceSymbols(o.dir)
	}
	if s.k("op").Op == "keyring.versions" {
		return checkKeyring(s, database)
	}
	if s.k("op").Op == "dbspec.introspect_shown" {
		return checkIntrospectShown(t, o.dir, s, database)
	}
	if s.k("op").Op == "dbspec.apply_fault" {
		return checkApplyFault(t, s, bound, database)
	}
	if s.k("op").Op == "dbspec.introspect_sqlite" {
		return checkIntrospectSQLite(t, s, database)
	}
	var r result
	switch s.k("op").Op {
	case "codec.decode":
		raw, err := argument(s.k("raw").Raw, bound)
		if err != nil {
			return err
		}
		r.styled, r.err = orm.Decode(s.k("styles").Styles, raw)
		r.decoded = true
	case "codec.encode":
		value, err := styledArgument(s.k("value").Value, s.k("styles").Styles, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.Encode(s.k("styles").Styles, value)
	case "codec.host_encode":
		value, err := argument(s.k("value").Value, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.HostEncode(value, s.k("styles").Styles, key(s))
	case "codec.host_decode":
		raw, err := argument(s.k("raw").Raw, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.HostDecode(raw, s.k("styles").Styles, key(s))
	case "codec.blind_index":
		value, err := argument(s.k("value").Value, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.BlindIndex(value, key(s))
	// dsn.connect (FCV-4): the DSN text of the step opened with Connect; a DSN that is refused never touches a database.
	case "dsn.connect":
		r.cell, r.err = connectDriver(s.k("dsn").DSN, "", s.k("config").Config)
	// markdown.connect (FCV-4, PRT-64): Connect on a markdown DSN, whose listener answers the first line with the reply.
	case "markdown.connect":
		r.err = markdownConnect(s)
	// markdown.session (FCV-4, PRT-64, PRT-66): the messages of the public calls of one connection on a listener that answers
	// from replies.
	case "markdown.session":
		r.err = markdownSession(s, o.markdownRead)
	default:
		return fmt.Errorf("OP_UNKNOWN %s", s.k("op").Op)
	}
	if s.k("as").As != "" {
		bound[s.k("as").As] = r
	}
	expect, ok := s.k("expect").Expect[database]
	if !ok {
		if r.err != nil {
			return fmt.Errorf("unexpected error %w", r.err)
		}
		return nil
	}
	return check(expect, r, s.k("styles").Styles)
}

// dsnConfig is the config field of dsn.connect (FCV-4; CFG-4, CFG-5, CFG-6).
type dsnConfig struct {
	PoolSize           int              `json:"pool_size"`
	PoolIdleSize       int              `json:"pool_idle_size"`
	PoolLifetimeMs     int              `json:"pool_lifetime_ms"`
	StatementTimeoutMs int              `json:"statement_timeout_ms"`
	TLSVersion         bool             `json:"tls_version"`
	AESKey             string           `json:"aes_key"`
	AESVersion         int32            `json:"aes_version"`
	AESKeys            map[int32]string `json:"aes_keys"`
	SessionRead        *struct {
		SQL databaseSQL `json:"sql"`
		Row []string    `json:"row"`
	} `json:"session_read"`
}

// databaseSQL is a statement text, one for every database or one per database by the dialect-key rule (dialectKey): the
// session_read of a MariaDB connection reads the variable of its server (DIA-208).
type databaseSQL map[string]string

// UnmarshalJSON reads a text, which every database runs, or an object of texts keyed by database.
func (d *databaseSQL) UnmarshalJSON(raw []byte) error {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		*d = databaseSQL{"": text}
		return nil
	}
	var entries map[string]string
	if err := json.Unmarshal(raw, &entries); err != nil {
		return err
	}
	*d = entries
	return nil
}

// of is the text that database runs.
func (d databaseSQL) of(database string) (string, error) {
	if text, every := d[""]; every {
		return text, nil
	}
	text, ok := d[dialectKey(database, d)]
	if !ok {
		return "", fmt.Errorf("the statement names no text for %s", database)
	}
	return text, nil
}

// sqliteFileName opens a SQLite DSN with the query on a new file called name, and returns the names in its directory
// other than the journals of that file (dsn.sqlite_file, CFG-26, COD-8).
func sqliteFileName(name, query string, config dsnConfig) (_ string, err error) {
	directory, err := os.MkdirTemp("", "orm-recipe-sqlite-name-")
	if err != nil {
		return "", err
	}
	defer removeTemp(directory, &err)
	_, refused := connectDriver("sqlite://"+filepath.Join(directory, name)+"?"+query, "sqlite", config)
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
func markdownConnect(s step) (err error) {
	var got string
	listener, err := listenOnce(func(conn net.Conn) error {
		line, err := bufio.NewReader(conn).ReadString('\n')
		if err != nil {
			return err
		}
		got = strings.TrimRight(line, "\n")
		_, err = fmt.Fprintln(conn, s.k("reply").Reply)
		return err
	})
	if err != nil {
		return err
	}
	defer func() { err = closeFirst(err, listener.Close()) }()
	_, connected := connectDriver(fmt.Sprintf("markdown://127.0.0.1:%d/%s?token=%s", listener.port, s.k("corpus").Corpus, s.k("token").Token), "markdown", dsnConfig{})
	if err := <-listener.served; err != nil {
		return err
	}
	if got != s.k("received").Received {
		return fmt.Errorf("the listener received %q, want %q", got, s.k("received").Received)
	}
	return connected
}

// markdownSession runs the markdown.session op: on a listener that answers each line with the next of the replies, the calls
// of the step on one connection. transactions runs a read-only transaction that holds a nested one, then a transaction, and
// returns the error of the last one; read runs one read of the bind fixture model, and read_twice runs two on the same
// connection, the second of which must succeed, and both return the error of the first read. It returns an error with no code
// when the listener did not receive the messages of the step.
func markdownSession(s step, read MarkdownRead) (err error) {
	call := s.k("call").Call
	if call != "transactions" && call != "read" && call != "read_twice" {
		return fmt.Errorf("markdown.session has no call %q", call)
	}
	if call != "transactions" && (read.Connect == nil || read.Read == nil) {
		return fmt.Errorf("markdown.session %s needs WithMarkdownRead", call)
	}
	var got []string
	listener, err := listenOnce(func(conn net.Conn) error {
		lines := bufio.NewScanner(conn)
		for lines.Scan() {
			got = append(got, lines.Text())
			if len(got) <= len(s.k("replies").Replies) {
				if _, err := fmt.Fprintln(conn, s.k("replies").Replies[len(got)-1]); err != nil {
					return err
				}
			}
		}
		return lines.Err()
	})
	if err != nil {
		return err
	}
	defer func() { err = closeFirst(err, listener.Close()) }()
	dsn := fmt.Sprintf("markdown://127.0.0.1:%d/%s?token=%s", listener.port, s.k("corpus").Corpus, s.k("token").Token)
	var failure error
	switch call {
	case "transactions":
		db, err := orm.Connect(dsn, orm.Config{})
		if err != nil {
			return fmt.Errorf("connect: %s", err.Error())
		}
		if err := db.Transaction(func() error {
			return db.Transaction(func() error { return nil })
		}, orm.ReadOnly()); err != nil {
			return fmt.Errorf("the read-only transaction: %s", err.Error())
		}
		failure = db.Transaction(func() error { return nil })
		if err := db.Close(); err != nil {
			return fmt.Errorf("close: %s", err.Error())
		}
	default:
		// One pooled connection, so the second read runs on the session of the first.
		db, err := read.Connect(dsn, orm.Config{PoolSize: 1})
		if err != nil {
			return fmt.Errorf("connect: %s", err.Error())
		}
		failure = read.Read(db)
		if call == "read_twice" {
			if err := read.Read(db); err != nil {
				return fmt.Errorf("the second read: %s", err.Error())
			}
		}
		if err := db.Close(); err != nil {
			return fmt.Errorf("close: %s", err.Error())
		}
	}
	if err := <-listener.served; err != nil {
		return err
	}
	if !slices.Equal(got, s.k("messages").Messages) {
		return fmt.Errorf("the listener received %q, want %q", got, s.k("messages").Messages)
	}
	return failure
}

// onceListener is a listener on a local port that serves its first connection in the background; served receives the
// error of that connection when it ends, after which what serve wrote may be read.
type onceListener struct {
	net.Listener
	port   int
	served chan error
}

// listenOnce listens on a local port and serves the first connection with serve, then closes that connection.
func listenOnce(serve func(conn net.Conn) error) (*onceListener, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		return nil, closeFirst(fmt.Errorf("the listener address is a %T", listener.Addr()), listener.Close())
	}
	served := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			served <- err
			return
		}
		served <- closeFirst(serve(conn), conn.Close())
	}()
	return &onceListener{Listener: listener, port: address.Port, served: served}, nil
}

// connectDriver opens the DSN with Connect, runs SELECT 1 through the statement runner (INT-150), closes the connection
// and returns its driver: the one implementation of dsn.connect (FCV-4).
func connectDriver(dsn, database string, config dsnConfig) (string, error) {
	db, err := orm.Connect(dsn, orm.Config{
		PoolSize:           config.PoolSize,
		PoolIdleSize:       config.PoolIdleSize,
		PoolLifetimeMs:     config.PoolLifetimeMs,
		StatementTimeoutMs: config.StatementTimeoutMs,
		AESKey:             config.AESKey,
		AESVersion:         config.AESVersion,
		AESKeys:            config.AESKeys,
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
		if config.SessionRead != nil {
			text, err := config.SessionRead.SQL.of(database)
			if err != nil {
				return err
			}
			read, err := f.Run(orm.KindUtility, nil, text)
			if err != nil {
				return err
			}
			if len(read.Rows) != 1 || len(read.Rows[0]) != len(config.SessionRead.Row) {
				return fmt.Errorf("%s returned %v, want %v", text, read.Rows, config.SessionRead.Row)
			}
			for i, want := range config.SessionRead.Row {
				cell := read.Rows[0][i]
				if text, isBytes := cell.([]byte); isBytes {
					cell = string(text)
				}
				if fmt.Sprint(cell) != want {
					return fmt.Errorf("%s cell %d is %v, want %s", text, i, cell, want)
				}
			}
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
	if s.k("key").Key == nil {
		return ""
	}
	return *s.k("key").Key
}

// check compares r with the outcome {value} or {error} of an expect.
func check(raw json.RawMessage, r result, styles []string) error {
	var outcome struct {
		Value        json.RawMessage `json:"value"`
		Error        string          `json:"error"`
		Message      string          `json:"message"`
		MessageHolds string          `json:"message_holds"`
		BytesPrefix  string          `json:"bytes_prefix_hex"`
		BytesLength  int             `json:"bytes_length"`
		LibraryCause bool            `json:"library_cause"`
	}
	if err := decodeOutcome(raw, &outcome); err != nil {
		return err
	}
	if outcome.Error != "" {
		if got := orm.ErrorCode(r.err); got != outcome.Error {
			return fmt.Errorf("error %q (%w), want %s", got, r.err, outcome.Error)
		}
		// library_cause: the error keeps the failure of the library that its rule meets as its cause (COD-71).
		if outcome.LibraryCause && errors.Unwrap(r.err) == nil {
			return fmt.Errorf("error %q has no cause, want the failure of the library", r.err.Error())
		}
		// message is the whole text of the error, its code included (INT-163).
		if outcome.Message != "" && r.err.Error() != outcome.Message {
			return fmt.Errorf("error message %q, want %q", r.err.Error(), outcome.Message)
		}
		if !strings.Contains(r.err.Error(), outcome.MessageHolds) {
			return fmt.Errorf("error %q, want a message that holds %q", r.err.Error(), outcome.MessageHolds)
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

// node is a recipe wrapper as a tree: its kind (int, float, text, bool, nil, null, bytes_hex, array, object, map_entries,
// and the time forms), its text, and its items or members in order. The entries of a map_entries wrapper are its items in
// pairs, each key followed by its value.
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

// hasOrderedValue is whether the value is an ordered-json value: a value whose every node has a JSON text, which bytes, a
// text that is not UTF-8, a float that is not finite and a map whose keys need not be strings have not, nested no deeper
// than the levels that the ordered-json parser reads.
func hasOrderedValue(n node, depth int) bool {
	switch n.kind {
	case "bytes_hex", "text_hex", "f64", "map_entries":
		return false
	case "array", "object":
		if depth+1 > orderedjson.MaxDepth {
			return false
		}
	}
	for _, item := range n.items {
		if !hasOrderedValue(item, depth+1) {
			return false
		}
	}
	for _, m := range n.members {
		if !hasOrderedValue(m.value, depth+1) {
			return false
		}
	}
	return true
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

// rawPairs reads body as a list of pairs of JSON values, the form of the object and map_entries wrappers of a recipe value.
func rawPairs(body json.RawMessage) ([][2]json.RawMessage, error) {
	var pairs [][2]json.RawMessage
	err := json.Unmarshal(body, &pairs)
	return pairs, err
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
			pairs, err := rawPairs(body)
			if err != nil {
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
		case "map_entries":
			pairs, err := rawPairs(body)
			if err != nil {
				return node{}, err
			}
			n := node{kind: kind}
			for _, pair := range pairs {
				for _, part := range pair {
					child, err := wrapper(part)
					if err != nil {
						return node{}, err
					}
					n.items = append(n.items, child)
				}
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
	// An ordered_json wrapper is the ordered-json value of its value, whatever the stages, and styled_unset is the styled
	// value that is neither SQL NULL nor a value (FCV-4).
	var probe map[string]json.RawMessage
	isOne := json.Unmarshal(raw, &probe) == nil && len(probe) == 1
	if isOne && probe["styled_unset"] != nil {
		var unset bool
		if err := json.Unmarshal(probe["styled_unset"], &unset); err != nil || !unset {
			return orm.StyledValue{}, fmt.Errorf("a styled_unset wrapper is {\"styled_unset\": true}: %s", raw)
		}
		return orm.StyledValue{}, nil
	}
	if isOne && probe["ordered_json"] != nil {
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
	// A value that is no ordered-json value, such as one that holds bytes, reaches an ordered_json stage as the Go value it
	// is (COD-63, COD-70).
	if slices.Contains(styles, "ordered_json") && hasOrderedValue(n, 0) {
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

// finiteF64 is the form of a finite f64 wrapper (scripts/features/schema/recipe.schema.json).
var finiteF64 = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

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
		// A finite f64 is a decimal number, as a float wrapper writes it; a runner compares it by its value.
		if !finiteF64.MatchString(n.text) {
			return nil, fmt.Errorf("an f64 wrapper is NaN, Infinity, -Infinity or a decimal number, not %q", n.text)
		}
		return strconv.ParseFloat(n.text, 64)
	case "text":
		return n.text, nil
	case "text_hex":
		// A Go string holds any bytes, so a text that is not UTF-8 is the string of its bytes (FCV-4).
		b, err := hex.DecodeString(n.text)
		return string(b), err
	case "bytes_hex":
		return hex.DecodeString(n.text)
	case "map_entries":
		// A Go map whose keys need not be strings (FCV-4).
		out := make(map[any]any, len(n.items)/2)
		for i := 0; i+1 < len(n.items); i += 2 {
			k, err := toGo(n.items[i])
			if err != nil {
				return nil, err
			}
			v, err := toGo(n.items[i+1])
			if err != nil {
				return nil, err
			}
			out[k] = v
		}
		return out, nil
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
	if e := decodeOutcome(raw, &outcome); e != nil {
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
	m, err := runtimemodel.LoadFiles(filepath.Join(dir, s.k("schema").Schema))
	if err != nil {
		return nil, nil, err
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal(s.k("input").Input, &input); err != nil {
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
	want, err := expectedValue(s, database)
	if err != nil {
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
	return sameJSON("ir.param_uses", map[string]any{"uses": list}, want)
}

// checkPlannerColumns states the output columns that the names of the step select from the first statement of the plan
// of each dialect: their type and whether they are hidden (PRT-69, DIA-33).
func checkPlannerColumns(dir string, s step, database string) error {
	want, err := expectedValue(s, database)
	if err != nil {
		return err
	}
	m, request, err := plannerRequest(dir, s)
	if err != nil {
		return err
	}
	for _, dialect := range plannerDialects {
		compiled, err := compiledPlan(m, dialect, request)
		if err != nil {
			return err
		}
		assemble := compiled.Steps[0].Assemble
		got := []any{}
		for _, name := range s.k("names").Names {
			for _, column := range assemble.Columns {
				if column.Name == name {
					got = append(got, map[string]any{"name": name, "type": column.Type, "hidden": column.Hidden})
				}
			}
		}
		if err := sameJSON("planner.columns "+dialect, got, want); err != nil {
			return err
		}
	}
	return nil
}

// expectedValue is the value of the expect of the step for the database.
func expectedValue(s step, database string) (json.RawMessage, error) {
	var outcome struct {
		Value json.RawMessage `json:"value"`
	}
	err := json.Unmarshal(s.k("expect").Expect[database], &outcome)
	return outcome.Value, err
}

// compiledPlan compiles the request for the dialect.
func compiledPlan(m *runtimemodel.Model, dialect string, request []byte) (plan.Plan, error) {
	var compiled plan.Plan
	e, err := engine.New(m, dialect)
	if err != nil {
		return compiled, err
	}
	out, err := e.Compile(request)
	if err != nil {
		return compiled, fmt.Errorf("%s: %w", dialect, err)
	}
	err = json.Unmarshal(out, &compiled)
	return compiled, err
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
	if s.k("schema").Schema == "" {
		return fmt.Errorf("planner.compile needs a schema")
	}
	raw, ok := s.k("expect").Expect[database]
	if !ok {
		return fmt.Errorf("planner.compile has no expect for %s", database)
	}
	var outcome struct {
		Value   json.RawMessage `json:"value"`
		Error   string          `json:"error"`
		Message string          `json:"message"`
	}
	if err := decodeOutcome(raw, &outcome); err != nil {
		return err
	}
	m, err := runtimemodel.LoadFiles(filepath.Join(dir, s.k("schema").Schema))
	if err != nil {
		return err
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal(s.k("input").Input, &input); err != nil {
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
		compiled, err := compiledPlan(m, dialect, request)
		if err != nil {
			return err
		}
		statements := plannerStatements(compiled)
		if s.k("assemble_types").AssembleTypes {
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
	want, ok := s.k("expect").Expect[database]
	if !ok {
		return fmt.Errorf("%s has no expect for %s", s.k("op").Op, database)
	}
	var got any
	var err error
	switch s.k("op").Op {
	case "dbspec.parse", "dbspec.parse_plan":
		got, err = dbspecParse(s, bound)
	case "dbspec.emit_plan":
		got, err = dbspecEmitPlan(s, bound)
	case "dbspec.diff":
		got, err = dbspecDiff(s, bound)
	case "dbspec.plan_steps":
		got, err = dbspecPlanSteps(s, bound)
	case "dbspec.introspect_refusal":
		got, err = dbspecIntrospectRefusal(s)
	case "dbspec.add_tables_steps":
		got, err = dbspecAddTablesSteps(s, bound)
	case "dbspec.chain":
		got, err = dbspecChain(s, bound)
	case "dbspec.compare":
		got, err = dbspecCompare(s, bound)
	default:
		return fmt.Errorf("OP_UNKNOWN %s", s.k("op").Op)
	}
	if err != nil {
		return err
	}
	return sameJSON(s.k("op").Op, got, want)
}

// dbspecParse runs dbspec.parse (Parse) or dbspec.parse_plan (ParsePlan) on the lines of s, binds the result to s.As, and
// returns {diagnostics: rows} with the rows of the diagnostics (parseRows).
func dbspecParse(s step, bound map[string]result) (any, error) {
	text := strings.Join(s.k("lines").Lines, "\n") + "\n"
	var diagnostics []dbspec.Diagnostic
	if s.k("op").Op == "dbspec.parse" {
		doc, _, d := dbspec.Parse(text, nil)
		diagnostics = d
		if s.k("as").As != "" {
			bound[s.k("as").As] = result{dbspec: doc}
		}
	} else {
		p, d := dbspec.ParsePlan(text)
		diagnostics = d
		if s.k("as").As != "" {
			bound[s.k("as").As] = result{dbspec: p}
		}
	}
	return map[string]any{"diagnostics": parseRows(diagnostics, false)}, nil
}

// dbspecEmitPlan runs dbspec.emit_plan (EmitPlan) on the plan that s names and returns {text: the emitted plan}.
func dbspecEmitPlan(s step, bound map[string]result) (any, error) {
	p, err := dbspecPlan(s.k("plan").Plan, bound)
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
	dialect := dbspec.Dialect(s.k("dialect").Dialect)
	if !knownDialect(dialect) {
		return dialectRefusal(s.k("dialect").Dialect, func() { dbspec.PlanSteps(source, plan, dialect) })
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
	source, target, err := dbspecSourceAndTarget(s, bound)
	if err != nil {
		return nil, err
	}
	added, steps, differences := dbspec.AddTablesAndColumnsSteps(source, nil, target, dbspec.Dialect(s.k("dialect").Dialect))
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
	plans := make([]*dbspec.Plan, 0, len(s.k("plans").Plans))
	for _, raw := range s.k("plans").Plans {
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
	source, target, err := dbspecSourceAndTarget(s, bound)
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
	source, err := dbspecDocument(s.k("source").Source, bound)
	if err != nil {
		return nil, nil, err
	}
	plan, err := dbspecPlan(s.k("plan").Plan, bound)
	return source, plan, err
}

// dbspecSourceAndTarget are the documents that the source and the target of s name.
func dbspecSourceAndTarget(s step, bound map[string]result) (source, target *dbspec.Document, err error) {
	source, err = dbspecDocument(s.k("source").Source, bound)
	if err != nil {
		return nil, nil, err
	}
	target, err = dbspecDocument(s.k("target").Target, bound)
	return source, target, err
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
// or {"error": <code>, "text": <whole text>} against the error the call returned before it sent a message; the text is optional.
// The expect is not per database.
func checkSend(t *testing.T, s step, fn MarkdownSend) error {
	if fn == nil {
		return fmt.Errorf("markdown.send needs WithMarkdownSend")
	}
	var begin *bool
	if s.k("begin").Begin != nil {
		var b struct {
			ReadOnly bool `json:"read_only"`
		}
		if err := json.Unmarshal(s.k("begin").Begin, &b); err != nil {
			return err
		}
		begin = &b.ReadOnly
	}
	message, failure := fn(t, s.k("column").Column, s.k("operator").Operator, s.k("params").Params, begin, s.k("process_zone").ProcessZone)
	return checkMessage(s.k("expect").Expect, message, failure)
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
	if err := json.Unmarshal(s.k("expect").Expect[database], &want); err != nil {
		return err
	}
	code, message := fn(t, s.k("calls").Calls)
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
	if err := json.Unmarshal(s.k("expect").Expect[database], &want); err != nil {
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
	for _, statement := range s.k("sql").SQL {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	_, unsupported, err := dbspec.Introspect(ctx, db, dbspec.DialectSQLite, dbspec.ServerSQLite, "introspected")
	if err != nil {
		return err
	}
	if !slices.Equal(unsupported, want.Unsupported) {
		return fmt.Errorf("unsupported objects = %+v, want %+v", unsupported, want.Unsupported)
	}
	return nil
}

// interfaceCheckDeadline ends a hung interface check within the Process deadline of its case, so that no check is left running and
// the case reports the failure itself.
const interfaceCheckDeadline = 280 * time.Second

// checkInterfaceSymbols runs one interface.symbols step: the interface check of the Go client from the repository root, three
// levels above dir, the directory of the recipe (INT-17, INT-18, INT-19, INT-57, INT-61, INT-64). The check exits 0 when it holds.
func checkInterfaceSymbols(dir string) error {
	ctx, cancel := context.WithTimeout(context.Background(), interfaceCheckDeadline)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "tests/interfaces/check/main.mts", "-language", "go")
	command.Dir = filepath.Join(dir, "..", "..", "..")
	// A child of the check that keeps the output pipes open ends the wait after the kill.
	command.WaitDelay = 10 * time.Second
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("interface check: %w\n%s", err, output)
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
	if err := json.Unmarshal(s.k("expect").Expect[database], &want); err != nil {
		return err
	}
	keyring, err := s.k("keyring").Keyring.keyring()
	if want.Error != "" {
		if err == nil {
			return fmt.Errorf("the keyring returned no error, want %s", want.Error)
		}
		if code := orm.ErrorCode(err); code != want.Error {
			return fmt.Errorf("the keyring returned %w, want %s", err, want.Error)
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
	message, code := fn(t, s.k("model").Model, s.k("column").Column, s.k("value").Value)
	return checkMessage(s.k("expect").Expect, message, code)
}

// checkMessage checks the message or the code of an error of a markdown listener step against its expect, {"message": JSON}
// or {"error": CODE}.
func checkMessage(expect map[string]json.RawMessage, message json.RawMessage, failure string) error {
	// The code of an error is its text up to the first colon, as every client writes it (PRT-32a).
	code, _, _ := strings.Cut(failure, ":")
	if raw, ok := expect["error"]; ok {
		var want string
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		if code != want {
			return fmt.Errorf("the call returned error %q, want %q (message %s)", failure, want, message)
		}
		if raw, ok := expect["text"]; ok {
			var text string
			if err := json.Unmarshal(raw, &text); err != nil {
				return err
			}
			if failure != text {
				return fmt.Errorf("the call returned %q, want %q", failure, text)
			}
		}
		return nil
	}
	raw, ok := expect["message"]
	if !ok {
		return fmt.Errorf("the step expects a message or an error")
	}
	if failure != "" {
		return fmt.Errorf("the call returned error %q before a message", failure)
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
	for _, entry := range s.k("keys").Keys {
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
	return sameKeyResult(got, s.k("expect").Expect[database])
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
