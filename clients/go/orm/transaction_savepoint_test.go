package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"strings"
	"sync"
	"testing"

	"github.com/polyspec/orm/engine/ir"
	_ "modernc.org/sqlite"
)

type transactionProbe struct {
	mu        sync.Mutex
	queries   []string
	execs     []string
	arguments [][]driver.NamedValue
	results   map[string]driver.Value
}

type transactionProbeDriver struct{ probe *transactionProbe }
type transactionProbeConn struct{ probe *transactionProbe }
type transactionProbeTx struct{}
type transactionProbeStmt struct {
	probe *transactionProbe
	query string
}
type transactionProbeRows struct {
	value driver.Value
	sent  bool
}

func (d transactionProbeDriver) Open(string) (driver.Conn, error) {
	return transactionProbeConn{probe: d.probe}, nil
}
func (c transactionProbeConn) Prepare(query string) (driver.Stmt, error) {
	return transactionProbeStmt{probe: c.probe, query: query}, nil
}
func (c transactionProbeConn) Close() error              { return nil }
func (c transactionProbeConn) Begin() (driver.Tx, error) { return transactionProbeTx{}, nil }
func (transactionProbeTx) Commit() error                 { return nil }
func (transactionProbeTx) Rollback() error               { return nil }
func (s transactionProbeStmt) Close() error              { return nil }
func (s transactionProbeStmt) NumInput() int             { return -1 }
func (s transactionProbeStmt) Exec([]driver.Value) (driver.Result, error) {
	return driver.RowsAffected(1), nil
}
func (s transactionProbeStmt) Query([]driver.Value) (driver.Rows, error) { return nil, driver.ErrSkip }
func (s transactionProbeStmt) ExecContext(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
	s.probe.mu.Lock()
	defer s.probe.mu.Unlock()
	s.probe.execs = append(s.probe.execs, s.query)
	s.probe.arguments = append(s.probe.arguments, append([]driver.NamedValue(nil), args...))
	return driver.RowsAffected(1), nil
}
func (s transactionProbeStmt) QueryContext(_ context.Context, args []driver.NamedValue) (driver.Rows, error) {
	s.probe.mu.Lock()
	defer s.probe.mu.Unlock()
	s.probe.queries = append(s.probe.queries, s.query)
	s.probe.arguments = append(s.probe.arguments, append([]driver.NamedValue(nil), args...))
	return &transactionProbeRows{value: s.probe.results[s.query]}, nil
}
func (r *transactionProbeRows) Columns() []string { return []string{"value"} }
func (r *transactionProbeRows) Close() error      { return nil }
func (r *transactionProbeRows) Next(dest []driver.Value) error {
	if r.sent {
		return io.EOF
	}
	r.sent = true
	dest[0] = r.value
	return nil
}

func probePostgresTx(t *testing.T, results map[string]driver.Value) (*Tx, *transactionProbe, func()) {
	t.Helper()
	probe := &transactionProbe{results: results}
	db := sql.OpenDB(transactionProbeConnector{probe: probe})
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	return &Tx{d: &DB{driver: "postgres"}, tx: tx}, probe, func() { _ = tx.Rollback(); _ = db.Close() }
}

type transactionProbeConnector struct{ probe *transactionProbe }

func (c transactionProbeConnector) Connect(context.Context) (driver.Conn, error) {
	return transactionProbeConn{probe: c.probe}, nil
}
func (c transactionProbeConnector) Driver() driver.Driver {
	return transactionProbeDriver{probe: c.probe}
}

func TestSavepointRollsBackOnlyChangesAfterMarker(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	ex := &Tx{tx: tx}
	ctx := context.Background()
	if _, err = tx.Exec(`INSERT INTO probe VALUES (1, 'before')`); err != nil {
		t.Fatal(err)
	}
	if err = ex.Savepoint(ctx, "before_second"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(`INSERT INTO probe VALUES (2, 'after')`); err != nil {
		t.Fatal(err)
	}
	if err = ex.RollbackTo(ctx, "before_second"); err != nil {
		t.Fatal(err)
	}
	if err = ex.ReleaseSavepoint(ctx, "before_second"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = db.QueryRow(`SELECT COUNT(*) FROM probe`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("savepoint rollback kept %d rows, want 1", count)
	}
}

func TestSavepointRejectsIdentifierInjection(t *testing.T) {
	if validSavepointName("safe_name_1") != true {
		t.Fatal("valid savepoint name rejected")
	}
	if validSavepointName("safe_name; DROP TABLE probe") {
		t.Fatal("savepoint injection accepted")
	}
}

func TestTransactionOptionsRejectUnsupportedSQLiteModes(t *testing.T) {
	for _, options := range []TransactionOptions{
		{Isolation: IsolationSerializable},
		{ReadOnly: true},
		{TimeoutMS: 1},
	} {
		if _, err := sqlTransactionOptions("sqlite", options); err == nil {
			t.Fatalf("sqlite accepted unsupported transaction options: %+v", options)
		} else if e, ok := err.(*ir.Error); !ok || e.Code != CodeCapabilityUnsupported {
			t.Fatalf("sqlite returned the wrong capability error: %v", err)
		}
	}
	if options, err := sqlTransactionOptions("postgres", TransactionOptions{Isolation: IsolationSerializable, ReadOnly: true}); err != nil || options.Isolation != sql.LevelSerializable || !options.ReadOnly {
		t.Fatalf("postgres transaction options were not translated: options=%+v err=%v", options, err)
	}
	if _, err := sqlTransactionOptions("postgres", TransactionOptions{TimeoutMS: 1}); err != nil {
		t.Fatalf("postgres timeout was rejected: %v", err)
	}
	if _, err := sqlTransactionOptions("postgres", TransactionOptions{TimeoutMS: -1}); err == nil {
		t.Fatal("negative transaction timeout was accepted")
	}
}

func TestAdvisoryLockRejectsUnsupportedDriver(t *testing.T) {
	tx := &Tx{d: &DB{driver: "sqlite"}}
	if err := tx.AdvisoryLock(context.Background(), 1); err == nil {
		t.Fatal("sqlite advisory lock was accepted")
	} else if e, ok := err.(*ir.Error); !ok || e.Code != CodeCapabilityUnsupported {
		t.Fatalf("wrong advisory lock error: %v", err)
	}
}

func TestInstallDDLRejectsEmptyStatements(t *testing.T) {
	tx := &Tx{tx: &sql.Tx{}}
	if err := tx.InstallDDL(context.Background(), []string{" "}); err == nil {
		t.Fatal("empty schema statement was accepted")
	}
}

func TestPostgresTransactionInspectionAPIs(t *testing.T) {
	const (
		readOnlySQL   = "SELECT current_setting('transaction_read_only')::boolean"
		isolationSQL  = "SELECT current_setting('transaction_isolation')"
		installedSQL  = "SELECT to_regclass($1)||'' IS NOT NULL"
		schemaSQL     = "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)"
		primaryKeySQL = `SELECT EXISTS(
 SELECT 1 FROM pg_attribute a JOIN pg_index i ON i.indrelid=a.attrelid
 WHERE a.attrelid=to_regclass($1) AND a.attname=$2 AND NOT a.attisdropped
 AND a.atttypid='uuid'::regtype AND a.attnotnull AND i.indisprimary
 AND a.attnum=ANY(i.indkey))`
	)
	tx, probe, closeDB := probePostgresTx(t, map[string]driver.Value{
		readOnlySQL: true, isolationSQL: "serializable", installedSQL: true, schemaSQL: false, primaryKeySQL: true,
	})
	defer closeDB()
	ctx := context.Background()
	if got, err := tx.ReadOnly(ctx); err != nil || !got {
		t.Fatalf("ReadOnly() = %v, %v", got, err)
	}
	if got, err := tx.Isolation(ctx); err != nil || got != "serializable" {
		t.Fatalf("Isolation() = %q, %v", got, err)
	}
	if got, err := tx.SchemaInstalled(ctx, "core", "initialization"); err != nil || !got {
		t.Fatalf("SchemaInstalled() = %v, %v", got, err)
	}
	if got, err := tx.SchemaExists(ctx, "audit"); err != nil || got {
		t.Fatalf("SchemaExists() = %v, %v", got, err)
	}
	if got, err := tx.PrimaryKeyColumn(ctx, "module.product", "owner_uuid"); err != nil || !got {
		t.Fatalf("PrimaryKeyColumn() = %v, %v", got, err)
	}
	if got := strings.Join(probe.queries, "\n"); got != strings.Join([]string{readOnlySQL, isolationSQL, installedSQL, schemaSQL, primaryKeySQL}, "\n") {
		t.Fatalf("inspection SQL = %q", got)
	}
	if got := probe.arguments[2][0].Value; got != "core.initialization" {
		t.Fatalf("SchemaInstalled argument = %#v", got)
	}
	if got := probe.arguments[3][0].Value; got != "audit" {
		t.Fatalf("SchemaExists argument = %#v", got)
	}
	if got := probe.arguments[4]; len(got) != 2 || got[0].Value != "module.product" || got[1].Value != "owner_uuid" {
		t.Fatalf("PrimaryKeyColumn arguments = %#v", got)
	}
}

func TestPostgresSetLocalAndRuntimePrivileges(t *testing.T) {
	tx, probe, closeDB := probePostgresTx(t, nil)
	defer closeDB()
	ctx := context.Background()
	if err := tx.SetLocal(ctx, "app.tenant", "tenant-1"); err != nil {
		t.Fatal(err)
	}
	if err := tx.GrantPlatformRuntimePrivileges(ctx, "runtime\"role"); err != nil {
		t.Fatal(err)
	}
	if len(probe.execs) != 9 {
		t.Fatalf("executed %d statements, want 9", len(probe.execs))
	}
	if got := probe.execs[0]; got != "SELECT set_config($1,$2,true)" {
		t.Fatalf("SetLocal SQL = %q", got)
	}
	if args := probe.arguments[0]; len(args) != 2 || args[0].Value != "app.tenant" || args[1].Value != "tenant-1" {
		t.Fatalf("SetLocal arguments = %#v", args)
	}
	for _, statement := range probe.execs[1:] {
		if !strings.HasSuffix(statement, ` TO "runtime""role"`) && !strings.HasSuffix(statement, ` FROM "runtime""role"`) {
			t.Fatalf("unquoted runtime role in %q", statement)
		}
	}
}

func TestPostgresTransactionAPIsRejectUnsupportedOrInvalidUse(t *testing.T) {
	unsupported := &Tx{d: &DB{driver: "sqlite"}}
	ctx := context.Background()
	for _, call := range []func() error{
		func() error { _, err := unsupported.ReadOnly(ctx); return err },
		func() error { _, err := unsupported.Isolation(ctx); return err },
		func() error { _, err := unsupported.SchemaInstalled(ctx, "core", "initialization"); return err },
		func() error { _, err := unsupported.SchemaExists(ctx, "core"); return err },
		func() error { _, err := unsupported.PrimaryKeyColumn(ctx, "core.table", "owner_uuid"); return err },
		func() error { return unsupported.SetLocal(ctx, "app.tenant", "tenant-1") },
		func() error { return unsupported.GrantPlatformRuntimePrivileges(ctx, "runtime") },
		func() error { _, err := unsupported.InstallerSessionAuthorized(ctx, "runtime"); return err },
	} {
		if err := call(); err == nil {
			t.Fatal("unsupported driver was accepted")
		} else if typed, ok := err.(*ir.Error); !ok || typed.Code != CodeCapabilityUnsupported {
			t.Fatalf("wrong unsupported-driver error: %v", err)
		}
	}
	probeTx, probe, closeDB := probePostgresTx(t, map[string]driver.Value{
		`SELECT current_user=session_user AND current_user<>$1
 AND EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='core' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=session_user))`: true,
	})
	defer closeDB()
	authorized, err := probeTx.InstallerSessionAuthorized(ctx, "runtime")
	if err != nil || !authorized {
		t.Fatalf("InstallerSessionAuthorized() = %v, %v", authorized, err)
	}
	if len(probe.arguments) != 1 || probe.arguments[0][0].Value != "runtime" {
		t.Fatalf("installer role argument = %#v", probe.arguments)
	}
	tx := &Tx{d: &DB{driver: "postgres"}}
	if err := tx.GrantPlatformRuntimePrivileges(ctx, " bad\nrole"); err == nil {
		t.Fatal("invalid runtime role was accepted")
	} else if typed, ok := err.(*ir.Error); !ok || typed.Code != CodeConfig {
		t.Fatalf("wrong invalid-role error: %v", err)
	}
	probeTx, probe, closeDB = probePostgresTx(t, nil)
	defer closeDB()
	if err := probeTx.GrantTablePrivileges(ctx, `module.product`, `runtime"role`); err != nil {
		t.Fatal(err)
	}
	if len(probe.execs) != 2 || !strings.HasSuffix(probe.execs[0], ` TO "runtime""role"`) || !strings.Contains(probe.execs[1], `"module"."product"`) {
		t.Fatalf("table privilege SQL = %#v", probe.execs)
	}
	for _, table := range []string{"product", "module.product.bad", "module\n.product"} {
		if err := probeTx.GrantTablePrivileges(ctx, table, "runtime"); err == nil {
			t.Fatalf("invalid table %q accepted", table)
		}
	}
}
