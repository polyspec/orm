package recipe

// The database path (FCV-3 and FCV-4): each case runs on a case database of its own through the public catalog API.

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/pg"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"
	"github.com/polyspec/orm/packages/go/testcase"
)

// schemaPath is the path of the recipe schema relative to the repository root; the `$schema` of a recipe names it by its
// path relative to the recipe (FCV-2), so the rest of that path leads from the recipe to the root.
const schemaPath = "scripts/features/schema/recipe.schema.json"

type databaseFile struct {
	Schema  string         `json:"$schema"`
	Fixture string         `json:"fixture"`
	Seed    *seed          `json:"seed"`
	Cases   []databaseCase `json:"cases"`
}

type seed struct {
	Rows json.RawMessage `json:"rows"`
}

type databaseCase struct {
	ID      string            `json:"id"`
	Install *bool             `json:"install"`
	Only    []string          `json:"only"`
	Seed    *seed             `json:"seed"`
	Steps   []json.RawMessage `json:"steps"`
}

// databaseStep holds the fields of every database op (scripts/features/schema/recipe.schema.json).
type databaseStep struct {
	Op             string          `json:"op"`
	DSN            json.RawMessage `json:"dsn"`
	Table          string          `json:"table"`
	Limit          int             `json:"limit"`
	Offset         int64           `json:"offset"`
	Columns        []string        `json:"columns"`
	Text           string          `json:"text"`
	Mode           string          `json:"mode"`
	SQL            json.RawMessage `json:"sql"`
	Refused        bool            `json:"refused"`
	RefusedMessage string          `json:"refused_message"`
	MaxRows        int             `json:"max_rows"`
	MaxBytes       int             `json:"max_bytes"`
	Page           json.RawMessage `json:"page"`
	Index          int             `json:"index"`
	Metadata       json.RawMessage `json:"metadata"`
	Values         json.RawMessage `json:"values"`
	Snapshot       json.RawMessage `json:"snapshot"`
	Set            json.RawMessage `json:"set"`
	As             string          `json:"as"`
	// The catalog fields: the databases that run the step, the namespace of a table, the binds and page of a query, and
	// the seq of a row.
	Only      []string                   `json:"only"`
	Namespace string                     `json:"namespace"`
	Binds     json.RawMessage            `json:"binds"`
	PageWith  json.RawMessage            `json:"page_with"`
	Seq       int64                      `json:"seq"`
	Expect    map[string]json.RawMessage `json:"expect"`
	Schema    json.RawMessage            `json:"schema"`
	Steps     []json.RawMessage          `json:"steps"`
	// Statements are the statements of utils.run (INT-150), which its one frame runs in order.
	// MessageContains is the text that the message of the expected error of schema.add_tables_and_columns holds.
	MessageContains string           `json:"message_contains"`
	Statements      []frameStatement `json:"statements"`
	// The model op fields (FCV-4): the connection name, the model name, the pool size, and the arguments of the model ops.
	Connection  string          `json:"connection"`
	Model       string          `json:"model"`
	PoolSize    int             `json:"pool_size"`
	Key         json.RawMessage `json:"key"`
	Where       json.RawMessage `json:"where"`
	Duplication json.RawMessage `json:"duplication"`
	Rows        json.RawMessage `json:"rows"`
	Batch       int             `json:"batch"`
	Order       []string        `json:"order"`
	Tuples      json.RawMessage `json:"tuples"`
	Relation    json.RawMessage `json:"relation"`
	Column      string          `json:"column"`
	Operation   string          `json:"operation"`
	// The lock of a model.query and the options of a transaction.
	Lock      string          `json:"lock"`
	Isolation string          `json:"isolation"`
	ReadOnly  bool            `json:"read_only"`
	Amount    json.RawMessage `json:"amount"`
	// The event fields (FCV-4): the subscription ref or the bound row, the kind that a failing subscriber refuses, the
	// compare mode of the captured events, and whether a transaction callback fails after its steps.
	Ref     json.RawMessage `json:"ref"`
	Row     json.RawMessage `json:"row"`
	Fail    bool            `json:"fail"`
	Kind    string          `json:"kind"`
	Compare string          `json:"compare"`
	// The request hook and AES ops (FCV-4): the hooks of hook.install, the keyring of a model.connect and the keyring
	// that utils.aes_status and utils.aes_rotate take.
	Hooks      []json.RawMessage `json:"hooks"`
	AESKeyring *aesKeyringSpec   `json:"aes_keyring"`
	Keyring    *aesKeyringSpec   `json:"keyring"`
	// The audit source of a model.connect (FCV-4).
	AuditSource *auditSourceSpec `json:"audit_source"`
	// The chain fields of a transaction, of utils.lock, utils.set_local and utils.local, and of events.captured (FCV-4):
	// the audit values, the name and value of a utility, and the binds that an expect does not compare by value.
	Audit json.RawMessage        `json:"audit"`
	Name  string                 `json:"name"`
	Value json.RawMessage        `json:"value"`
	Masks map[string][]eventMask `json:"masks"`
	// The channel and payload of a db.notify (FCV-4).
	Channel string `json:"channel"`
	Payload string `json:"payload"`
}

// eventMask replaces one bind of one captured event with a name, for a value that no recipe can fix (FCV-4).
type eventMask struct {
	Event int    `json:"event"`
	Bind  int    `json:"bind"`
	Value string `json:"value"`
}

// bound is what a step bound with `as`: the API value that a later argument takes, the fields of its result that a dotted
// ref reads, and the value wrapper of a step whose result is one value.
type bound struct {
	api    any
	fields map[string]any
	value  any
	// hookBase is the connection that model.connect opened, when hook.install bound api to it with a request hook.
	hookBase *orm.DB
}

// snapshotOf is a bound row snapshot with the metadata of the page it was taken from, which the Go snapshot keeps
// unexported and the mutation result of an update needs for the native types of its columns.
type snapshotOf struct {
	snapshot orm.CatalogRowSnapshot
	metadata orm.CatalogTableMetadata
}

// outcome is what an op produced: the API value to bind, and the fields that its expect compares.
type outcome struct {
	api    any
	fields map[string]any
}

type databaseContext struct {
	t         *testing.T
	ctx       context.Context
	db        *orm.DB
	dir       string
	catalog   *orm.CatalogConnection
	namespace string
	database  string
	dsn       string
	schema    *orm.Schema
	// tablePath is true for a fixture that generates no models: its model ops run on the entities of its tables (FCV-4).
	tablePath bool
	bound     map[string]bound
	// closers close the connections that model.connect opened, when the case ends.
	closers []func() error
	// records are the requests that a record action of the installed hook saw (hook.records).
	records []hookRecord
}

// runDatabase runs every case of the recipe at path on database, each as a subtest on a case database of its own (FCV-3).
func runDatabase(t *testing.T, path, database string) {
	t.Helper()
	if database != "mysql" && database != "postgres" && database != "sqlite" {
		t.Fatalf("recipe %s: unknown database %s", path, database)
	}
	f := readRecipe[databaseFile](t, path)
	if f.Fixture == "" {
		t.Fatalf("recipe %s: no fixture, so it has no database", path)
	}
	// A fixture of "none" runs every case on an empty case database (FCV-3); the helper never infers it.
	var schema *orm.Schema
	var external []*orm.Schema
	if f.Fixture != "none" {
		relative, ok := strings.CutSuffix(f.Schema, schemaPath)
		if !ok {
			t.Fatalf("recipe %s: $schema %s does not name %s", path, f.Schema, schemaPath)
		}
		root := filepath.Join(filepath.Dir(path), relative)
		var err error
		schema, external, err = fixtureSchema(filepath.Join(root, f.Fixture))
		if err != nil {
			t.Fatalf("recipe %s: %v", path, err)
		}
	}
	for _, c := range f.Cases {
		// A case with only runs on the databases it names; the others do not register it (TypeScript does the same).
		if len(c.Only) > 0 && !slices.Contains(c.Only, database) {
			continue
		}
		t.Run(c.ID, func(t *testing.T) {
			testcase.Start(t, testcase.Database)
			runCase(t, path, f, c, database, schema, external)
		})
	}
}

// caseSocketDSN is the MySQL DSN of the case database through the Unix socket of the test environment (FCV-4, CFG-10): the
// user and the database of the case DSN, with the host localhost and the socket as its socket parameter.
func caseSocketDSN(caseDSN, socket string) (string, error) {
	m := mysqlCaseDSN.FindStringSubmatch(caseDSN)
	if m == nil {
		return "", fmt.Errorf("dsn case-socket: the case DSN %q is not a mysql DSN", caseDSN)
	}
	return "mysql://" + m[1] + "@localhost/" + m[2] + "?socket=" + socket, nil
}

// mysqlCaseDSN splits a MySQL DSN into its user and its database: mysql://user@host:port/database.
var mysqlCaseDSN = regexp.MustCompile(`^mysql://([^@/]+)@[^/]+/([^?]+)`)

// connectDSN resolves the DSN of a model.connect step (FCV-4): an absent DSN or "case" is the case database, "case-socket" is
// the MySQL case database through the socket ORM_TEST_MYSQL_SOCKET (CFG-10, a MySQL-only parameter, CFG-19), and other text
// is the DSN it names.
func connectDSN(dsn, database, caseDSN string) (string, error) {
	switch dsn {
	case "", "case":
		return caseDSN, nil
	case "case-socket":
		if database != "mysql" {
			return "", fmt.Errorf("dsn case-socket needs mysql, not %s", database)
		}
		socket := os.Getenv("ORM_TEST_MYSQL_SOCKET")
		if socket == "" {
			return "", errors.New("dsn case-socket: ORM_TEST_MYSQL_SOCKET is unset; run make orm-test-servers")
		}
		return caseSocketDSN(caseDSN, socket)
	}
	return dsn, nil
}

// fixtureSchema is the Schema of a dbspec-set.json through the public dbspec API (docs/spec/dbspec.md "External
// documents"): the owned documents parsed with the external ones of the set, and the manifest of the owned documents
// with the external text. Each external document is also a schema of its own, which a case installs first, as the
// bench set does (benchset.Install), since its tables must exist before the set installs.
func fixtureSchema(setPath string) (*orm.Schema, []*orm.Schema, error) {
	set, errs := dbspec.ReadSet(setPath)
	if len(errs) > 0 {
		return nil, nil, fmt.Errorf("%s: %+v", setPath, errs)
	}
	var owned, external []string
	for _, file := range set.Documents {
		owned = append(owned, string(file.Bytes))
	}
	for _, file := range set.External {
		external = append(external, string(file.Bytes))
	}
	manifestOf := func(texts, externals []string) (*dbspec.Manifest, error) {
		var documents []*dbspec.Document
		for _, parsed := range dbspec.ParseSet(texts, externals) {
			if parsed.Document == nil || len(parsed.Diagnostics) > 0 {
				return nil, fmt.Errorf("%s: %s: %+v", setPath, parsed.Name, parsed.Diagnostics)
			}
			documents = append(documents, parsed.Document)
		}
		manifest, diagnostics := dbspec.ManifestOf(documents)
		if manifest == nil {
			return nil, fmt.Errorf("%s: %+v", setPath, diagnostics)
		}
		return manifest, nil
	}
	manifest, err := manifestOf(owned, external)
	if err != nil {
		return nil, nil, err
	}
	var installFirst []*orm.Schema
	for _, text := range external {
		shared, err := manifestOf([]string{text}, nil)
		if err != nil {
			return nil, nil, err
		}
		installFirst = append(installFirst, &orm.Schema{Hash: shared.ManifestHash, Text: shared.ManifestText})
	}
	return &orm.Schema{Hash: manifest.ManifestHash, Text: manifest.ManifestText, External: manifest.ExternalText}, installFirst, nil
}

func runCase(t *testing.T, path string, f databaseFile, c databaseCase, database string, schema *orm.Schema, external []*orm.Schema) {
	step := testcase.Of(t)
	ctx := step.Context()
	dsn := testdb.New(t, database)
	db, err := orm.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatalf("recipe %s case %s on %s: connect: %v", path, c.ID, database, err)
	}
	defer testcase.Close(t, db)
	// A case with install: false gets no fixture here; its steps install it (FCV-4, schema.install).
	if schema != nil && (c.Install == nil || *c.Install) {
		for _, shared := range append(external, schema) {
			if err := db.Utils().Schema().Install(shared); err != nil {
				t.Fatalf("recipe %s case %s on %s: install: %v", path, c.ID, database, err)
			}
		}
		step.Step("schema installed")
	}
	catalog, err := orm.ConnectCatalog(dsn)
	if err != nil {
		t.Fatalf("recipe %s case %s on %s: catalog: %v", path, c.ID, database, err)
	}
	namespace, err := catalog.CurrentNamespace(ctx)
	if err != nil {
		t.Fatalf("recipe %s case %s on %s: current namespace: %v", path, c.ID, database, err)
	}
	name := testdb.DatabaseOf(t, dsn)
	if database == "sqlite" {
		name = strings.TrimSuffix(filepath.Base(strings.TrimPrefix(dsn, "sqlite://")), ".sqlite")
	}
	state := &databaseContext{
		t: t, ctx: ctx, db: db, dir: filepath.Dir(path), catalog: catalog, namespace: namespace, database: database, dsn: dsn, schema: schema, tablePath: f.Fixture != generatedFixture,
		bound: map[string]bound{"database": {value: map[string]any{"text": name}}},
	}
	defer func() {
		for _, closeConnection := range state.closers {
			if err := closeConnection(); err != nil {
				t.Errorf("recipe %s case %s: close connection: %v", path, c.ID, err)
			}
		}
	}()
	defer func() {
		if state.catalog != nil {
			testcase.Close(t, state.catalog)
		}
	}()
	for _, s := range []*seed{f.Seed, c.Seed} {
		if s == nil || len(s.Rows) == 0 {
			continue
		}
		if err := insertSeed(state, s.Rows); err != nil {
			t.Fatalf("recipe %s case %s on %s: seed: %v", path, c.ID, database, err)
		}
	}
	step.Step("seed rows inserted")
	for index, raw := range c.Steps {
		op, err := runRawStep(raw, state)
		if err != nil {
			t.Fatalf("recipe %s case %s step %d (%s) on %s: %v", path, c.ID, index, op, database, err)
		}
		step.Step("step %d %s", index, op)
	}
}

// insertSeed inserts the seed rows of each table, in the order of the recipe, with insert_row and the metadata that
// describe_table reads.
func insertSeed(c *databaseContext, rows json.RawMessage) error {
	tables, err := orderedMembers(rows)
	if err != nil {
		return err
	}
	for _, table := range tables {
		metadata, err := c.catalog.DescribeTable(c.ctx, orm.CatalogTableRef{Namespace: c.namespace, Name: table.key})
		if err != nil {
			return fmt.Errorf("describe %s: %w", table.key, err)
		}
		var values []json.RawMessage
		if err := json.Unmarshal(table.value, &values); err != nil {
			return err
		}
		for i, row := range values {
			assigned, err := assignments(row, c)
			if err != nil {
				return err
			}
			if _, err := c.catalog.InsertRow(c.ctx, metadata, assigned); err != nil {
				return fmt.Errorf("%s row %d: %w", table.key, i, err)
			}
		}
	}
	return nil
}

// runRawStep decodes one step and runs it. A model op of a fixture that generates no models has the query fields, which
// chain.go reads; every other step is a databaseStep. It returns the name of the op.
func runRawStep(raw json.RawMessage, c *databaseContext) (string, error) {
	if c.tablePath {
		var head struct {
			Op     string                     `json:"op"`
			As     string                     `json:"as"`
			Only   []string                   `json:"only"`
			Expect map[string]json.RawMessage `json:"expect"`
		}
		if err := json.Unmarshal(raw, &head); err != nil {
			return "", err
		}
		if chainOps[head.Op] {
			s := databaseStep{Op: head.Op, As: head.As, Only: head.Only, Expect: head.Expect}
			return head.Op, runStepWith(s, c, func(databaseStep, *databaseContext) (outcome, error) { return chainOp(raw, c) })
		}
	}
	var s databaseStep
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", err
	}
	return s.Op, runDatabaseStep(s, c)
}

// runDatabaseStep maps the op of s to its call and compares the fields that its expect names.
func runDatabaseStep(s databaseStep, c *databaseContext) error {
	return runStepWith(s, c, databaseOp)
}

// runStepWith runs a step through op and compares the fields that its expect names.
func runStepWith(s databaseStep, c *databaseContext, op func(databaseStep, *databaseContext) (outcome, error)) error {
	// A step with only runs on the databases it names, and its expect names exactly those (scripts/features/schema/recipe.schema.json).
	if len(s.Only) > 0 && !slices.Contains(s.Only, c.database) {
		return nil
	}
	var expected map[string]any
	if raw, ok := s.Expect[c.database]; ok {
		var parsed any
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return err
		}
		resolved, err := resolveRefs(parsed, c)
		if err != nil {
			return err
		}
		object, isObject := resolved.(map[string]any)
		if !isObject {
			return fmt.Errorf("the expect of %s is not an object", c.database)
		}
		expected = object
	}
	result, err := op(s, c)
	if err != nil {
		code := orm.ErrorCode(err)
		if errors.Is(err, errCallback) {
			code = callbackCode
		}
		want, wantsError := expected["error"]
		if !wantsError || code == "" {
			return err
		}
		if code != want {
			return fmt.Errorf("error %q (%w), want %v", code, err, want)
		}
		if suffix, ok := expected["message_suffix"].(string); ok && !strings.HasSuffix(err.Error(), suffix) {
			return fmt.Errorf("error message %q does not end with %q", err.Error(), suffix)
		}
		if holds, ok := expected["message_holds"].(string); ok && !strings.Contains(err.Error(), holds) {
			return fmt.Errorf("error message %q does not hold %q", err.Error(), holds)
		}
		if expected["driver_cause"] == true && errors.Unwrap(err) == nil {
			return fmt.Errorf("error %q has no driver cause", err.Error())
		}
		return nil
	}
	if s.As != "" {
		c.bound[s.As] = bound{api: result.api, fields: result.fields, value: result.fields["value"]}
	}
	if expected == nil {
		return nil
	}
	if want, ok := expected["error"]; ok {
		return fmt.Errorf("expected %v, and the op succeeded", want)
	}
	compared := map[string]any{}
	for key := range expected {
		compared[key] = result.fields[key]
	}
	got, err := jsonTree(compared)
	if err != nil {
		return err
	}
	want, err := jsonTree(expected)
	if err != nil {
		return err
	}
	if got, want := normalized(got), normalized(want); !reflect.DeepEqual(got, want) {
		return fmt.Errorf("got %s, want %s", jsonString(got), jsonString(want))
	}
	return nil
}

// closeFirst returns the first error of a step. A close failure is the step's error only when the step has none of its own;
// otherwise it is joined after the first error, so that neither is lost.
func closeFirst(err, closeErr error) error {
	if closeErr == nil {
		return err
	}
	if err == nil {
		return closeErr
	}
	return errors.Join(err, closeErr)
}

// readBindCell reads the body of the bind cell at seq through a new connection, and closes that connection.
func readBindCell(dsn string, seq int64) (out outcome, err error) {
	db, err := model.Connect(dsn, orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	if err != nil {
		return outcome{}, err
	}
	defer func() {
		err = closeFirst(err, db.Close())
	}()
	row, err := model.BindCell().Connect(db).Seq(seq).Get()
	if err != nil {
		return outcome{}, err
	}
	body, err := row.GetBody()
	if err != nil {
		return outcome{}, err
	}
	if body == nil {
		return outcome{fields: map[string]any{"value": map[string]any{"null": "text"}}}, nil
	}
	return outcome{fields: map[string]any{"value": map[string]any{"text": *body}}}, nil
}

// databaseOp calls the public API that the op names and returns the fields that its expect compares (FCV-4).
func databaseOp(s databaseStep, c *databaseContext) (outcome, error) {
	switch s.Op {
	case "catalog.current_namespace":
		namespace, err := c.catalog.CurrentNamespace(c.ctx)
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{"value": map[string]any{"text": namespace}}}, nil
	case "catalog.describe_table":
		namespace := c.namespace
		if s.Namespace != "" {
			namespace = s.Namespace
		}
		metadata, err := c.catalog.DescribeTable(c.ctx, orm.CatalogTableRef{Namespace: namespace, Name: s.Table})
		if err != nil {
			return outcome{}, err
		}
		names := make([]string, len(metadata.Columns))
		natives := make([]string, len(metadata.Columns))
		nullable := make([]bool, len(metadata.Columns))
		generated := make([]bool, len(metadata.Columns))
		automatic := make([]bool, len(metadata.Columns))
		defaults := make([]bool, len(metadata.Columns))
		for i, column := range metadata.Columns {
			names[i] = column.Name
			natives[i] = column.NativeType
			nullable[i] = column.Nullable
			generated[i] = column.Generated
			automatic[i] = column.AutomaticKey
			defaults[i] = column.DefaultExpression != nil
		}
		return outcome{api: metadata, fields: map[string]any{
			"namespace": map[string]any{"text": metadata.Table.Namespace},
			"kind":      string(metadata.Kind), "columns_present": len(metadata.Columns) > 0,
			"columns": names, "native_types": natives, "primary_key": metadata.PrimaryKey, "reliable_row_identity": metadata.ReliableRowIdentity,
			"nullable": nullable, "generated": generated, "automatic_keys": automatic, "defaults": defaults,
		}}, nil
	case "catalog.table_page":
		page, err := c.catalog.TablePage(c.ctx, orm.CatalogTableRef{Namespace: c.namespace, Name: s.Table}, s.Limit, s.Offset)
		if err != nil {
			return outcome{}, err
		}
		names := make([]string, len(page.Result.Columns))
		for i, column := range page.Result.Columns {
			names[i] = column.Name
		}
		indexes := make([]int, len(s.Columns))
		for i, column := range s.Columns {
			at := indexOf(names, column)
			if at < 0 {
				return outcome{}, fmt.Errorf("the page has no column %s", column)
			}
			indexes[i] = at
		}
		rows := []any{}
		for _, row := range page.Result.Rows {
			cells := make([]any, len(indexes))
			for i, at := range indexes {
				cell, err := plain(row[at], page.Result.Columns[at].NativeType, c.database)
				if err != nil {
					return outcome{}, err
				}
				cells[i] = cell
			}
			rows = append(rows, cells)
		}
		return outcome{api: page, fields: map[string]any{
			"columns": names, "order_by": page.OrderBy, "has_more": page.HasMore, "rows": rows,
		}}, nil
	case "catalog.read_only_query":
		query, err := databaseText(s.SQL, c)
		if err != nil {
			return outcome{}, err
		}
		binds, err := queryBinds(s.Binds, c)
		if err != nil {
			return outcome{}, err
		}
		result, err := c.catalog.ReadOnlyQuery(c.ctx, query, binds, orm.CatalogQueryLimits{MaxRows: s.MaxRows, MaxBytes: s.MaxBytes})
		if err != nil {
			return outcome{}, err
		}
		rows, err := cellRows(result.Rows, func(value any) (any, error) { return plain(value, "", c.database) })
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{"columns": result.Columns, "row_count": len(result.Rows), "rows": rows}}, nil
	case "catalog.read_only_grid_query":
		query, err := databaseText(s.SQL, c)
		if err != nil {
			return outcome{}, err
		}
		result, err := c.catalog.ReadOnlyGridQuery(c.ctx, query, nil, orm.CatalogQueryLimits{MaxRows: s.MaxRows, MaxBytes: s.MaxBytes})
		if err != nil {
			return outcome{}, err
		}
		rows, err := cellRows(result.Rows, gridWrapper)
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{"columns": result.Columns, "rows": rows}}, nil
	case "catalog.row_snapshot":
		raw := s.Page
		if len(s.PageWith) > 0 {
			var with struct {
				Page    json.RawMessage `json:"page"`
				OrderBy []string        `json:"order_by"`
			}
			if err := json.Unmarshal(s.PageWith, &with); err != nil {
				return outcome{}, err
			}
			raw = with.Page
		}
		page, err := boundAPI[orm.CatalogTablePage](raw, c)
		if err != nil {
			return outcome{}, err
		}
		if len(s.PageWith) > 0 {
			var with struct {
				OrderBy    []string `json:"order_by"`
				ColumnName *string  `json:"column_name"`
			}
			if err := json.Unmarshal(s.PageWith, &with); err != nil {
				return outcome{}, err
			}
			page.OrderBy = with.OrderBy
			if with.ColumnName != nil {
				page.Metadata.Columns = slices.Clone(page.Metadata.Columns)
				page.Metadata.Columns[0].Name = *with.ColumnName
			}
		}
		snapshot, err := orm.CatalogSnapshotFromPage(page, s.Index)
		if err != nil {
			return outcome{}, err
		}
		keys := snapshot.Keys()
		keyCells := make([]any, len(keys))
		for i, key := range keys {
			cell, err := plain(key, "", c.database)
			if err != nil {
				return outcome{}, err
			}
			keyCells[i] = cell
		}
		return outcome{api: snapshotOf{snapshot: snapshot, metadata: page.Metadata}, fields: map[string]any{
			"keys": keyCells, "key_indexes": snapshot.KeyIndexes(),
		}}, nil
	case "catalog.revision":
		snapshot, err := boundAPI[snapshotOf](s.Snapshot, c)
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{"value": map[string]any{"text": snapshot.snapshot.Revision()}}}, nil
	case "catalog.row_cells":
		snapshot, err := boundAPI[snapshotOf](s.Snapshot, c)
		if err != nil {
			return outcome{}, err
		}
		captured := snapshot.snapshot.CapturedCells()
		cells := make([]any, len(captured))
		for i, cell := range captured {
			cells[i], err = plain(cell, snapshot.metadata.Columns[i].NativeType, c.database)
			if err != nil {
				return outcome{}, err
			}
		}
		return outcome{fields: map[string]any{"cells": cells}}, nil
	case "catalog.connect":
		var target struct {
			URL        *string `json:"url"`
			SQLiteFile string  `json:"sqlite_file"`
		}
		if err := json.Unmarshal(s.DSN, &target); err != nil {
			return outcome{}, err
		}
		if target.URL != nil {
			connection, err := orm.ConnectCatalog(*target.URL)
			if err != nil {
				return outcome{}, err
			}
			return outcome{}, connection.Close()
		}
		// A SQLite file that the case does not create: the connection fails, and the file must not exist afterwards.
		path := filepath.Join(c.t.TempDir(), "absent.sqlite")
		connection, err := orm.ConnectCatalog("sqlite://" + path)
		var closeErr error
		if connection != nil {
			closeErr = connection.Close()
		}
		if _, statErr := os.Stat(path); statErr == nil {
			return outcome{}, closeFirst(fmt.Errorf("the connection created %s", path), closeErr)
		}
		if err == nil {
			return outcome{}, closeFirst(fmt.Errorf("the connection to an absent SQLite file succeeded"), closeErr)
		}
		return outcome{}, closeFirst(err, closeErr)
	case "catalog.close":
		// The closed connection stays bound: its operations fail with CATALOG_CLOSED and send no statement.
		return outcome{}, c.catalog.Close()
	case "catalog.reconnect":
		catalog, err := orm.ConnectCatalog(c.dsn)
		if err != nil {
			return outcome{}, err
		}
		namespace, err := catalog.CurrentNamespace(c.ctx)
		if err != nil {
			return outcome{}, closeFirst(err, catalog.Close())
		}
		c.catalog = catalog
		c.namespace = namespace
		return outcome{}, nil
	case "model.read_bind_cell":
		return readBindCell(c.dsn, s.Seq)
	case "catalog.insert_row":
		metadata, err := boundAPI[orm.CatalogTableMetadata](s.Metadata, c)
		if err != nil {
			return outcome{}, err
		}
		values, err := assignments(s.Values, c)
		if err != nil {
			return outcome{}, err
		}
		result, err := c.catalog.InsertRow(c.ctx, metadata, values)
		if err != nil {
			return outcome{}, err
		}
		return mutation(metadata, result, c.database)
	case "catalog.update_row":
		original, err := boundAPI[snapshotOf](s.Snapshot, c)
		if err != nil {
			return outcome{}, err
		}
		values, err := assignments(s.Set, c)
		if err != nil {
			return outcome{}, err
		}
		result, err := c.catalog.UpdateRow(c.ctx, original.snapshot, values)
		if err != nil {
			return outcome{}, err
		}
		return mutation(original.metadata, result, c.database)
	case "catalog.delete_row":
		original, err := boundAPI[snapshotOf](s.Snapshot, c)
		if err != nil {
			return outcome{}, err
		}
		deleted, err := c.catalog.DeleteRow(c.ctx, original.snapshot)
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.FormatInt(deleted, 10)}}}, nil
	case "schema.install":
		if s.Connection != "" {
			db, err := connectionOf(s, c)
			if err != nil {
				return outcome{}, err
			}
			if err := db.Utils().Schema().Install(c.schema); err != nil {
				return outcome{}, err
			}
			return okOutcome(), nil
		}
		schema, err := schemaArgument(s.Schema, c)
		if err != nil {
			return outcome{}, err
		}
		if err := c.db.Utils().Schema().Install(schema); err != nil {
			return outcome{}, err
		}
		return okOutcome(), nil
	case "schema.register":
		schema, err := schemaArgument(s.Schema, c)
		if err != nil {
			return outcome{}, err
		}
		if err := c.db.Utils().Schema().Register(schema); err != nil {
			return outcome{}, err
		}
		return okOutcome(), nil
	case "schema.connect":
		schema, err := schemaArgument(s.Schema, c)
		if err != nil {
			return outcome{}, err
		}
		connected, err := orm.ConnectSchema(c.dsn, schema, orm.Config{})
		if err != nil {
			return outcome{}, err
		}
		if err := connected.Close(); err != nil {
			return outcome{}, err
		}
		return okOutcome(), nil
	case "schema.add_tables_and_columns":
		schema, err := schemaArgument(s.Schema, c)
		if err != nil {
			return outcome{}, err
		}
		added, err := c.db.Utils().Schema().AddTablesAndColumns(schema)
		if err != nil {
			if !strings.Contains(err.Error(), s.MessageContains) {
				return outcome{}, fmt.Errorf("the message %q holds no %q", err.Error(), s.MessageContains)
			}
			return outcome{}, err
		}
		names := make([]any, len(added))
		for i, name := range added {
			names[i] = map[string]any{"text": name}
		}
		return outcome{fields: map[string]any{"value": map[string]any{"array": names}}}, nil
	case "statements.count":
		var count int64
		stop, err := c.db.Subscribe(func(orm.StatementEvent) error {
			count++
			return nil
		})
		if err != nil {
			return outcome{}, err
		}
		runErr := runNested(s.Steps, c)
		stop()
		if runErr != nil {
			return outcome{}, runErr
		}
		return outcome{fields: map[string]any{"count": count}}, nil
	case "transaction":
		db, err := connectionOf(s, c)
		if err != nil {
			return outcome{}, err
		}
		// The options of the transaction (INT-46): a nested transaction that names one is refused with CONFIG.
		options := []orm.TransactionOption{orm.Retry(0)}
		if s.Isolation != "" {
			options = append(options, orm.Isolation(orm.IsolationLevel(s.Isolation)))
		}
		if s.ReadOnly {
			options = append(options, orm.ReadOnly())
		}
		if s.Audit != nil {
			values, err := auditValues(s.Audit, c)
			if err != nil {
				return outcome{}, err
			}
			options = append(options, orm.Audit(values))
		}
		err = db.Transaction(func() error {
			if err := runNested(s.Steps, c); err != nil {
				return err
			}
			if s.Fail {
				return errCallback
			}
			return nil
		}, options...)
		if err != nil {
			return outcome{}, err
		}
		return okOutcome(), nil
	case "sql.exec":
		statement, present, err := sqlExecText(s.SQL, c)
		if err != nil {
			return outcome{}, err
		}
		if !present {
			return okOutcome(), nil
		}
		raw := testdb.Open(c.t, c.database, c.dsn)
		defer testcase.Close(c.t, raw)
		if s.Refused && c.database == "sqlite" {
			// A native SQLite connection starts with foreign keys off; the runners of the other clients open it with them on.
			raw.SetMaxOpenConns(1)
			if _, err := raw.ExecContext(c.ctx, "PRAGMA foreign_keys = ON"); err != nil {
				return outcome{}, err
			}
		}
		_, err = raw.ExecContext(c.ctx, statement)
		if s.Refused {
			if err == nil {
				return outcome{}, fmt.Errorf("the database accepted the statement that the step expects it to refuse: %s", statement)
			}
			if !strings.Contains(strings.ToLower(err.Error()), s.RefusedMessage) {
				return outcome{}, fmt.Errorf("the database refused the statement for another reason: %w", err)
			}
			return outcome{fields: map[string]any{}}, nil
		}
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{}}, nil
	case "query.search":
		return searchOp(s, c)
	case "query.search_chain":
		return searchChainOp(s, c)
	// dsn.connect (FCV-4): the DSN of the case database for "case", otherwise the text of the step, opened with Connect.
	case "dsn.connect":
		var dsn string
		if err := json.Unmarshal(s.DSN, &dsn); err != nil {
			return outcome{}, fmt.Errorf("dsn.connect: dsn is not a text: %w", err)
		}
		if dsn == "case" {
			dsn = c.dsn
		}
		driver, err := connectDriver(dsn)
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{"value": map[string]any{"text": driver}}}, nil
	}
	switch s.Op {
	// The ops of the model connections (FCV-4), by their full names.
	case "model.connect", "model.create", "model.creates", "model.save", "model.duplicate_create", "model.update",
		"model.arithmetic", "model.delete", "model.count", "model.get_by", "model.query", "model.restore":
		return modelOp(s, c)
	}
	if out, handled, err := statementOp(s, c); handled {
		return out, err
	}
	return requestOp(s, c)
}

// connectionOf is the connection that an op names with its connection field, or the case connection when the field is
// empty (FCV-4).
func connectionOf(s databaseStep, c *databaseContext) (*orm.DB, error) {
	if s.Connection == "" {
		return c.db, nil
	}
	b, ok := c.bound[s.Connection]
	if !ok {
		return nil, fmt.Errorf("connection %q is not bound", s.Connection)
	}
	db, ok := b.api.(*orm.DB)
	if !ok {
		return nil, fmt.Errorf("connection %q is a %T, not a connection", s.Connection, b.api)
	}
	return db, nil
}

// okOutcome is the value of an op that returns without error (FCV-4).
func okOutcome() outcome {
	return outcome{fields: map[string]any{"value": map[string]any{"bool": true}}}
}

// runNested runs the nested steps of a statements.count or transaction op, each with its own expect (FCV-4).
func runNested(raw []json.RawMessage, c *databaseContext) error {
	for index, nested := range raw {
		op, err := runRawStep(nested, c)
		if err != nil {
			return fmt.Errorf("nested step %d (%s): %w", index, op, err)
		}
	}
	return nil
}

// schemaArgument builds the generated schema value of a schema argument: the documents of the set and the external
// documents it uses, read from the recipe's directory and built through the public engine, with manifest_replace
// applied to the manifest text after building, so that the text no longer hashes to its declared hash (FCV-4).
func schemaArgument(raw json.RawMessage, c *databaseContext) (*orm.Schema, error) {
	var arg struct {
		Documents       []string `json:"documents"`
		External        []string `json:"external"`
		ManifestReplace *struct {
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"manifest_replace"`
	}
	if err := json.Unmarshal(raw, &arg); err != nil {
		return nil, fmt.Errorf("schema argument: %w", err)
	}
	read := func(names []string) ([]string, error) {
		texts := make([]string, len(names))
		for i, name := range names {
			src, err := os.ReadFile(filepath.Join(c.dir, name))
			if err != nil {
				return nil, err
			}
			texts[i] = string(src)
		}
		return texts, nil
	}
	owned, err := read(arg.Documents)
	if err != nil {
		return nil, err
	}
	external, err := read(arg.External)
	if err != nil {
		return nil, err
	}
	m, diagnostics := runtimemodel.LoadDocumentSet(owned, external)
	if len(diagnostics) > 0 {
		return nil, fmt.Errorf("schema: %s", runtimemodel.DiagnosticsError(diagnostics))
	}
	text := m.ManifestText
	if arg.ManifestReplace != nil {
		text = strings.ReplaceAll(text, arg.ManifestReplace.From, arg.ManifestReplace.To)
	}
	return &orm.Schema{Hash: m.ManifestHash, Text: text, External: m.ExternalText}, nil
}

func indexOf(names []string, name string) int {
	for i, n := range names {
		if n == name {
			return i
		}
	}
	return -1
}

// databaseText is a field that holds SQL or a database-decided value: the string itself, or the entry of the database.
func databaseText(raw json.RawMessage, c *databaseContext) (string, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text, nil
	}
	var entries map[string]string
	if err := json.Unmarshal(raw, &entries); err != nil {
		return "", fmt.Errorf("a SQL field is a string or an object of the databases: %s", raw)
	}
	text, ok := entries[c.database]
	if !ok {
		return "", fmt.Errorf("the SQL field has no entry for %s", c.database)
	}
	return text, nil
}

// sqlExecText is the text of a sql.exec field for the case database. A string runs on every database; an object runs
// only where its key is present, so an absent key reports present false and the step runs nothing (FCV-4).
func sqlExecText(raw json.RawMessage, c *databaseContext) (string, bool, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text, true, nil
	}
	var entries map[string]string
	if err := json.Unmarshal(raw, &entries); err != nil {
		return "", false, fmt.Errorf("a SQL field is a string or an object of the databases: %s", raw)
	}
	text, present := entries[c.database]
	return text, present, nil
}

// refName is the name of a {"ref": ...} field, or "" for another field.
func refName(raw json.RawMessage) string {
	var name string
	if json.Unmarshal(raw, &name) == nil {
		return name
	}
	var ref struct {
		Ref string `json:"ref"`
	}
	if json.Unmarshal(raw, &ref) != nil {
		return ""
	}
	return ref.Ref
}

// boundAPI is the API value that a {"ref": "<name>"} argument names.
func boundAPI[T any](raw json.RawMessage, c *databaseContext) (T, error) {
	var zero T
	name := refName(raw)
	if name == "" {
		return zero, fmt.Errorf("the argument %s is not a ref", raw)
	}
	b, ok := c.bound[name]
	if !ok {
		return zero, fmt.Errorf("no bound value %s", name)
	}
	v, ok := b.api.(T)
	if !ok {
		return zero, fmt.Errorf("bound value %s is a %T, not a %T", name, b.api, zero)
	}
	return v, nil
}

// boundTree is the value of {"ref": "<name>"}, the value wrapper of the bound step or else its fields, or of
// {"ref": "<name>.<path>"}, the field at path in the fields of the bound step's result.
func boundTree(ref string, c *databaseContext) (any, error) {
	head, rest, dotted := strings.Cut(ref, ".")
	b, ok := c.bound[head]
	if !ok {
		return nil, fmt.Errorf("no bound value %s", head)
	}
	if !dotted {
		if b.value != nil {
			return b.value, nil
		}
		return b.fields, nil
	}
	tree, err := jsonTree(b.fields)
	if err != nil {
		return nil, err
	}
	for _, key := range strings.Split(rest, ".") {
		switch node := tree.(type) {
		case map[string]any:
			if tree, ok = node[key]; !ok {
				return nil, fmt.Errorf("bound value %s has no %s", head, rest)
			}
		case []any:
			index, err := strconv.Atoi(key)
			if err != nil || index < 0 || index >= len(node) {
				return nil, fmt.Errorf("bound value %s has no %s", head, rest)
			}
			tree = node[index]
		default:
			return nil, fmt.Errorf("bound value %s has no %s", head, rest)
		}
	}
	return tree, nil
}

// resolveRefs replaces each {"ref": ...} object of an expect with the bound value it names.
func resolveRefs(value any, c *databaseContext) (any, error) {
	switch v := value.(type) {
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			resolved, err := resolveRefs(item, c)
			if err != nil {
				return nil, err
			}
			out[i] = resolved
		}
		return out, nil
	case map[string]any:
		if ref, ok := v["ref"].(string); ok && len(v) == 1 {
			return boundTree(ref, c)
		}
		out := make(map[string]any, len(v))
		for key, item := range v {
			resolved, err := resolveRefs(item, c)
			if err != nil {
				return nil, err
			}
			out[key] = resolved
		}
		return out, nil
	}
	return value, nil
}

type rawMember struct {
	key   string
	value json.RawMessage
}

// orderedMembers reads the members of a JSON object in the order of its text.
func orderedMembers(raw json.RawMessage) ([]rawMember, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, fmt.Errorf("expected an object: %s", raw)
	}
	var out []rawMember
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, fmt.Errorf("an object member starts with %v, not a key", token)
		}
		out = append(out, rawMember{key: key, value: value})
	}
	return out, nil
}

// cellRows converts each cell of rows with convert, keeping the rows and their order.
func cellRows[T any](rows [][]T, convert func(T) (any, error)) ([]any, error) {
	out := []any{}
	for _, row := range rows {
		cells := make([]any, len(row))
		for i, cell := range row {
			converted, err := convert(cell)
			if err != nil {
				return nil, err
			}
			cells[i] = converted
		}
		out = append(out, cells)
	}
	return out, nil
}

// assignments are the assignments of an object of column names, in its order, whose values are recipe wrappers, refs to
// bound value wrappers or per-database objects.
// queryBinds reads the positional binds of a read-only query: a list of recipe values, each converted as an assignment value.
func queryBinds(raw json.RawMessage, c *databaseContext) ([]any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	out := make([]any, len(items))
	for i, item := range items {
		value, err := assignmentValue(item, c)
		if err != nil {
			return nil, fmt.Errorf("bind %d: %w", i+1, err)
		}
		out[i] = value
	}
	return out, nil
}

// assignments reads the named values of a step: an object in its key order, or a list of [name, value] pairs.
func assignments(raw json.RawMessage, c *databaseContext) ([]orm.CatalogAssignment, error) {
	var members []rawMember
	if trimmed := bytes.TrimSpace(raw); len(trimmed) > 0 && trimmed[0] == '[' {
		var pairs [][]json.RawMessage
		if err := json.Unmarshal(raw, &pairs); err != nil {
			return nil, err
		}
		for _, pair := range pairs {
			if len(pair) != 2 {
				return nil, fmt.Errorf("an assignment is a [name, value] pair, not %d items", len(pair))
			}
			var name string
			if err := json.Unmarshal(pair[0], &name); err != nil {
				return nil, err
			}
			members = append(members, rawMember{key: name, value: pair[1]})
		}
	} else {
		var err error
		members, err = orderedMembers(raw)
		if err != nil {
			return nil, err
		}
	}
	out := make([]orm.CatalogAssignment, 0, len(members))
	for _, m := range members {
		value, err := assignmentValue(m.value, c)
		if err != nil {
			return nil, fmt.Errorf("column %s: %w", m.key, err)
		}
		out = append(out, orm.CatalogAssignment{Name: m.key, Value: value})
	}
	return out, nil
}

func assignmentValue(raw json.RawMessage, c *databaseContext) (any, error) {
	if name := refName(raw); name != "" {
		tree, err := boundTree(name, c)
		if err != nil {
			return nil, err
		}
		if raw, err = json.Marshal(tree); err != nil {
			return nil, err
		}
	}
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, err
	}
	if len(entries) == 3 && entries["mysql"] != nil && entries["postgres"] != nil && entries["sqlite"] != nil {
		raw = entries[c.database]
	}
	n, err := wrapper(raw)
	if err != nil {
		return nil, err
	}
	return nativeArgument(n)
}

// nativeArgument is the value of the Go catalog API for a recipe wrapper: a temporal or decimal value is its text.
func nativeArgument(n node) (any, error) {
	switch n.kind {
	case "int":
		if i, err := strconv.ParseInt(n.text, 10, 64); err == nil {
			return i, nil
		}
		return strconv.ParseUint(n.text, 10, 64)
	case "text", "date", "time", "datetime", "decimal":
		return n.text, nil
	case "bytes_hex":
		return hex.DecodeString(n.text)
	case "bool":
		return n.text == "true", nil
	case "null":
		return nil, nil
	case "array":
		// An array is the list of an IN filter of a model op (FCV-4, DSL-46).
		items := make([]any, len(n.items))
		for i, item := range n.items {
			v, err := nativeArgument(item)
			if err != nil {
				return nil, err
			}
			items[i] = v
		}
		return items, nil
	}
	return nil, fmt.Errorf("unknown recipe wrapper %s", n.kind)
}

// plain is the recipe wrapper of a plain catalog value; a string takes the wrapper of the native type of its column when
// one is known.
func plain(value any, nativeType, database string) (any, error) {
	switch v := value.(type) {
	case nil:
		return map[string]any{"null": true}, nil
	case int64:
		return map[string]any{"int": strconv.FormatInt(v, 10)}, nil
	case bool:
		return map[string]any{"bool": v}, nil
	case float64:
		// The shortest text that reads back as the same float, as the TypeScript runner writes a number.
		return map[string]any{"float": strconv.FormatFloat(v, 'g', -1, 64)}, nil
	case []byte:
		return map[string]any{"bytes_hex": hex.EncodeToString(v)}, nil
	case string:
		kind := temporalKind(nativeType)
		if kind == "" {
			kind = "text"
		}
		return map[string]any{kind: v}, nil
	case time.Time:
		return plainTime(v, nativeType, database)
	}
	return nil, fmt.Errorf("no recipe wrapper for the plain value %v (%T)", value, value)
}

var declaredPrecision = regexp.MustCompile(`\(([0-9]+)\)`)

// plainTime is the recipe wrapper of a time.Time plain value. A Go plain value carries no fraction digits, so the helper
// writes the declared precision p of the column: the p of its native type, or without one the default of INT-101 (0 on
// MySQL, 6 on PostgreSQL). The digit count of a Go plain value is therefore not asserted, only its value; a column whose p
// cannot be decided fails the step.
func plainTime(v time.Time, nativeType, database string) (any, error) {
	kind := temporalKind(nativeType)
	v = v.UTC()
	if kind == "date" {
		return map[string]any{"date": v.Format("2006-01-02")}, nil
	}
	if kind != "datetime" && kind != "time" {
		return nil, fmt.Errorf("no recipe wrapper for the time value %s of native type %q", v, nativeType)
	}
	var p int
	if m := declaredPrecision.FindStringSubmatch(nativeType); m != nil {
		var err error
		if p, err = strconv.Atoi(m[1]); err != nil {
			return nil, err
		}
	} else {
		switch database {
		case "mysql":
			p = 0
		case "postgres":
			p = 6
		default:
			return nil, fmt.Errorf("the time value %s of native type %q on %s has no declared precision", v, nativeType, database)
		}
	}
	if p > 9 {
		return nil, fmt.Errorf("native type %q declares precision %d", nativeType, p)
	}
	layout := "2006-01-02 15:04:05"
	if kind == "time" {
		layout = "15:04:05"
	}
	text := v.Format(layout)
	if p > 0 {
		text += "." + fmt.Sprintf("%09d", v.Nanosecond())[:p]
	}
	return map[string]any{kind: text}, nil
}

func temporalKind(nativeType string) string {
	t := strings.ToLower(nativeType)
	switch {
	case strings.HasPrefix(t, "datetime"), strings.HasPrefix(t, "timestamp"):
		return "datetime"
	case strings.HasPrefix(t, "time"):
		return "time"
	case strings.HasPrefix(t, "date"):
		return "date"
	case strings.HasPrefix(t, "decimal"), strings.HasPrefix(t, "numeric"):
		return "decimal"
	}
	return ""
}

// gridWrapper is the recipe wrapper of a grid cell, by its kind.
func gridWrapper(cell orm.CatalogGridCell) (any, error) {
	switch cell.Kind {
	case orm.CatalogGridNull:
		return map[string]any{"null": true}, nil
	case orm.CatalogGridInteger:
		return map[string]any{"int": fmt.Sprint(cell.Value)}, nil
	case orm.CatalogGridUnsigned:
		return map[string]any{"uint": fmt.Sprint(cell.Value)}, nil
	case orm.CatalogGridFloat32:
		return map[string]any{"f32_bits": cell.Value}, nil
	case orm.CatalogGridFloat64:
		return map[string]any{"f64_bits": fmt.Sprint(cell.Value)}, nil
	case orm.CatalogGridDecimal, orm.CatalogGridText, orm.CatalogGridDate, orm.CatalogGridTime, orm.CatalogGridDateTime:
		return map[string]any{string(cell.Kind): cell.Value}, nil
	case orm.CatalogGridBoolean:
		return map[string]any{"bool": cell.Value}, nil
	case orm.CatalogGridBinary:
		b, ok := cell.Value.([]byte)
		if !ok {
			return nil, fmt.Errorf("binary grid cell of type %T", cell.Value)
		}
		return map[string]any{"bytes_hex": hex.EncodeToString(b)}, nil
	}
	return nil, fmt.Errorf("no recipe wrapper for the grid cell %s", cell.Kind)
}

// mutation is the fields of a mutation result: its rows, each cell wrapped by the native type of its column in the
// metadata.
func mutation(metadata orm.CatalogTableMetadata, result orm.CatalogMutationResult, database string) (outcome, error) {
	types := make([]string, len(result.Columns))
	for i, name := range result.Columns {
		for _, column := range metadata.Columns {
			if column.Name == name {
				types[i] = column.NativeType
			}
		}
	}
	rows := []any{}
	for _, row := range result.Rows {
		cells := make([]any, len(row))
		for i, value := range row {
			cell, err := plain(value, types[i], database)
			if err != nil {
				return outcome{}, err
			}
			cells[i] = cell
		}
		rows = append(rows, cells)
	}
	return outcome{fields: map[string]any{"rows": rows}}, nil
}

// jsonTree is v as the tree that encoding/json reads from its text, so that results and expects compare alike.
func jsonTree(v any) (any, error) {
	text, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var tree any
	err = json.Unmarshal(text, &tree)
	return tree, err
}

func jsonString(v any) string {
	text, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(text)
}

// normalized compares NULL by its nullness: an expect names the parameter type of NULL, and a result has none.
func normalized(value any) any {
	switch v := value.(type) {
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = normalized(item)
		}
		return out
	case map[string]any:
		if _, ok := v["null"]; ok && len(v) == 1 {
			return map[string]any{"null": true}
		}
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = normalized(item)
		}
		return out
	}
	return value
}
