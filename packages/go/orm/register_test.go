package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/stdlib"
	sqlite "modernc.org/sqlite"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/testcase"
)

// sentStatements is the number of statements and transaction starts that countingDriver sent to the database.
var sentStatements atomic.Int64

// countingDriver wraps a real driver and counts all statements, prepares,
// and transaction starts that a connection sends to the database.
type countingDriver struct{ base driver.Driver }

func (d countingDriver) Open(name string) (driver.Conn, error) {
	c, err := d.base.Open(name)
	if err != nil {
		return nil, err
	}
	return countingConn{c}, nil
}

type countingConn struct{ driver.Conn }

func (c countingConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	sentStatements.Add(1)
	e, ok := c.Conn.(driver.ExecerContext)
	if !ok {
		return nil, driver.ErrSkip
	}
	return e.ExecContext(ctx, query, args)
}

func (c countingConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	sentStatements.Add(1)
	q, ok := c.Conn.(driver.QueryerContext)
	if !ok {
		return nil, driver.ErrSkip
	}
	return q.QueryContext(ctx, query, args)
}

func (c countingConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	sentStatements.Add(1)
	if p, ok := c.Conn.(driver.ConnPrepareContext); ok {
		return p.PrepareContext(ctx, query)
	}
	return c.Conn.Prepare(query)
}

func (c countingConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	sentStatements.Add(1)
	b, ok := c.Conn.(driver.ConnBeginTx)
	if !ok {
		return nil, errors.New("the wrapped test driver does not implement ConnBeginTx")
	}
	return b.BeginTx(ctx, opts)
}

func (c countingConn) CheckNamedValue(v *driver.NamedValue) error {
	if n, ok := c.Conn.(driver.NamedValueChecker); ok {
		return n.CheckNamedValue(v)
	}
	return driver.ErrSkip
}

var registerCountingDrivers sync.Once

// useCountingDriver makes the client driver name countingDriver until the test ends.
func useCountingDriver(t *testing.T, name string) {
	t.Helper()
	registerCountingDrivers.Do(func() {
		sql.Register("orm-counting-mysql", countingDriver{mysql.MySQLDriver{}})
		sql.Register("orm-counting-postgres", countingDriver{stdlib.GetDefaultDriver()})
		sql.Register("orm-counting-sqlite", countingDriver{&sqlite.Driver{}})
	})
	driverMu.Lock()
	previousDriver, hadDriver := sqlDrivers[name]
	previousMapper, hadMapper := errMappers[name]
	driverMu.Unlock()
	mapper := previousMapper
	if mapper == nil {
		// This package's tests do not import the PostgreSQL driver package. This test
		// does not check driver errors, so it leaves them as they are.
		mapper = func(err error) error { return err }
	}
	RegisterDriver(name, "orm-counting-"+name, mapper)
	t.Cleanup(func() {
		driverMu.Lock()
		defer driverMu.Unlock()
		if hadDriver {
			sqlDrivers[name] = previousDriver
		} else {
			delete(sqlDrivers, name)
		}
		if hadMapper {
			errMappers[name] = previousMapper
		} else {
			delete(errMappers, name)
		}
	})
}

// registerFixture is a set in which the external/member document of contracts/fixtures uses the tables of the external/core document.
// Since it uses an external document, a registration that reads the database performs introspection.
func registerFixture(t *testing.T) *Schema {
	t.Helper()
	m, diagnostics := runtimemodel.LoadDocumentSet(registerTexts(t, "external/member"), registerTexts(t, "external/core"))
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	return &Schema{Hash: m.ManifestHash, Text: m.ManifestText, External: m.ExternalText}
}

// registerTexts reads the dbspec documents of contracts/fixtures by name.
func registerTexts(t *testing.T, names ...string) []string {
	t.Helper()
	texts := make([]string, len(names))
	for i, name := range names {
		b, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", name+".dbs"))
		if err != nil {
			t.Fatal(err)
		}
		texts[i] = string(b)
	}
	return texts
}

// TestRegisterSendsNoStatement checks that registration sends no statement to the database,
// by wrapping the driver and counting (docs/spec/schema.md "Schema registration"). Register and ConnectSchema
// registration does not read the database even for a set that uses external documents, and a request for a registered set is planned.
// Manifest text that does not hash to the declared hash is CONFIG with no statement.
func TestRegisterSendsNoStatement(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schema := registerFixture(t)
	note, diagnostics := runtimemodel.LoadDocumentSet(registerTexts(t, "install/note"), nil)
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	other := &Schema{Hash: note.ManifestHash, Text: note.ManifestText}
	for _, name := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(name, func(t *testing.T) {
			dsn := testdb.New(t, name)
			useCountingDriver(t, name)
			db, err := Connect(dsn, Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			before := sentStatements.Load()
			if err := db.Utils().Schema().Register(schema); err != nil {
				t.Fatalf("register: %v", err)
			}
			if err := db.Utils().Schema().Register(schema); err != nil {
				t.Fatalf("second register: %v", err)
			}
			// The manifest text of another set does not hash to the declared hash.
			edited := &Schema{Hash: schema.Hash, Text: other.Text}
			if err := db.Utils().Schema().Register(edited); ErrorCode(err) != CodeConfig {
				t.Fatalf("register of an edited manifest text = %v, want CONFIG", err)
			}
			if sent := sentStatements.Load() - before; sent != 0 {
				t.Fatalf("register sent %d statements, want 0", sent)
			}
			if _, err := db.engineFor(schema); err != nil {
				t.Fatalf("the registered set is not planned: %v", err)
			}
			// ConnectSchema sends only the statements that Connect sends.
			before = sentStatements.Load()
			plain, err := Connect(dsn, Config{})
			if err != nil {
				t.Fatal(err)
			}
			connectSent := sentStatements.Load() - before
			if err := plain.Close(); err != nil {
				t.Fatal(err)
			}
			before = sentStatements.Load()
			connected, err := ConnectSchema(dsn, schema, Config{})
			if err != nil {
				t.Fatalf("connect with the schema: %v", err)
			}
			defer connected.Close()
			if sent := sentStatements.Load() - before; sent != connectSent {
				t.Fatalf("ConnectSchema sent %d statements, Connect %d; registering must send none", sent, connectSent)
			}
		})
	}
}
