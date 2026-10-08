package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/stdlib"
	sqlite "modernc.org/sqlite"

	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/internal/testdb"
)

// sentStatements는 countingDriver가 database에 보낸 statement와 transaction 시작 수다.
var sentStatements atomic.Int64

// countingDriver는 실제 driver를 감싸고 연결이 database에 보내는 statement, prepare,
// transaction 시작을 모두 센다.
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

// useCountingDriver는 test가 끝날 때까지 client driver name을 countingDriver로 연다.
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
		// 이 package의 test는 PostgreSQL driver package를 import하지 않는다. 이 test는
		// driver 오류를 검사하지 않으므로 오류를 그대로 둔다.
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

// registerFixture는 contracts/fixtures의 external/member 문서가 external/core 문서의
// table을 쓰는 set이다. 외부 문서를 쓰므로 database를 읽는 등록이라면 introspection을 한다.
func registerFixture(t *testing.T) *Schema {
	t.Helper()
	path := func(name string) string { return filepath.Join("..", "..", "..", "contracts", "fixtures", name+".dbs") }
	m, err := runtimemodel.LoadFileSet([]string{path("external/member")}, []string{path("external/core")})
	if err != nil {
		t.Fatal(err)
	}
	return &Schema{Hash: m.ManifestHash, Text: m.ManifestText, External: m.ExternalText}
}

// TestRegisterSendsNoStatement는 등록이 database에 아무 statement도 보내지 않는지
// driver를 감싸 센다(docs/schema.md "Schema registration"). Register와 ConnectSchema의
// 등록은 외부 문서를 쓰는 set도 database를 읽지 않고, 등록한 set의 요청은 plan된다.
// 선언한 hash로 hash되지 않는 manifest text는 statement 없이 CONFIG다.
func TestRegisterSendsNoStatement(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schema := registerFixture(t)
	note, err := runtimemodel.LoadFileSet([]string{filepath.Join("..", "..", "..", "contracts", "fixtures", "install", "note.dbs")}, nil)
	if err != nil {
		t.Fatal(err)
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
			// 다른 set의 manifest text는 선언한 hash로 hash되지 않는다.
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
			// ConnectSchema는 Connect가 보내는 statement만 보낸다.
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
