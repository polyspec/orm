package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/testcase"
)

func catalogSessionWithOpenTransaction(t *testing.T) *catalogSession {
	t.Helper()
	useFailingDriver(t, "sqlite")
	pool, err := sql.Open("orm-failing-sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testcase.Close(t, pool) })
	ctx := context.Background()
	conn, err := pool.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := conn.Close(); err != nil && !errors.Is(err, sql.ErrConnDone) {
			t.Errorf("close *sql.Conn: %v", err)
		}
	})
	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		t.Fatal(err)
	}
	return &catalogSession{ctx: ctx, conn: conn, dialect: "sqlite"}
}

// Requirements: INT-72.
func TestCatalogSessionEndPreservesPrimaryAndRollbackCauses(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	session := catalogSessionWithOpenTransaction(t)
	inject(t, injectedFailure{rollback: true})

	primaryCause := errors.New("catalog query failed")
	primary := &ir.Error{Code: catalogCodeMetadata, Msg: "primary catalog failure", Cause: primaryCause}
	err := session.end(primary)
	if ErrorCode(err) != catalogCodeMetadata {
		t.Fatalf("primary error code = %q, want %q", ErrorCode(err), catalogCodeMetadata)
	}
	if !errors.Is(err, primaryCause) {
		t.Fatalf("primary cause was lost: %v", err)
	}
	if !strings.Contains(err.Error(), CodeRowRollbackFailed) {
		t.Fatalf("rollback code is missing: %v", err)
	}
	if !errors.Is(err, errRollbackRejected) {
		t.Fatalf("rollback driver cause was lost: %v", err)
	}
}

// Requirements: INT-72.
func TestCatalogSessionEndReportsRollbackCauseWithoutPrimary(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	session := catalogSessionWithOpenTransaction(t)
	inject(t, injectedFailure{rollback: true})

	err := session.end(nil)
	if ErrorCode(err) != CodeRowRollbackFailed {
		t.Fatalf("rollback error code = %q, want %q", ErrorCode(err), CodeRowRollbackFailed)
	}
	if !errors.Is(err, errRollbackRejected) {
		t.Fatalf("rollback driver cause was lost: %v", err)
	}
}

// Requirements: INT-118, PRT-79.
func TestCatalogInsertPreservesIndeterminateCommitCause(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	useFailingDriver(t, "sqlite")
	catalog, metadata := openCatalogSQLiteDefaultFixture(t, "commit_cause", "CREATE TABLE commit_cause (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)")
	inject(t, injectedFailure{statement: func(query string) bool { return query == "COMMIT" }})

	_, err := catalog.InsertRow(context.Background(), metadata, []CatalogAssignment{{Name: "payload", Value: "value"}})
	if ErrorCode(err) != catalogCodeCommitUnknown {
		t.Fatalf("InsertRow commit error code = %q (%v), want %s", ErrorCode(err), err, catalogCodeCommitUnknown)
	}
	if !errors.Is(err, errStatementRejected) {
		t.Fatalf("InsertRow lost the native commit cause: %v", err)
	}
}

type catalogVisibilityState struct {
	partialRevokes int64
	directGrant    bool
	inserted       bool
	queries        []string
}

type catalogVisibilityConnector struct{ state *catalogVisibilityState }

func (c catalogVisibilityConnector) Connect(context.Context) (driver.Conn, error) {
	return &catalogVisibilityConn{state: c.state}, nil
}

func (catalogVisibilityConnector) Driver() driver.Driver { return catalogVisibilityDriver{} }

type catalogVisibilityDriver struct{}

func (catalogVisibilityDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("catalog visibility driver must use its connector")
}

type catalogVisibilityConn struct{ state *catalogVisibilityState }

func (c *catalogVisibilityConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("catalog visibility fixture does not prepare statements")
}

func (c *catalogVisibilityConn) Close() error { return nil }

func (c *catalogVisibilityConn) Begin() (driver.Tx, error) {
	return catalogVisibilityTx{}, nil
}

func (c *catalogVisibilityConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return catalogVisibilityTx{}, nil
}

func (c *catalogVisibilityConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.state.queries = append(c.state.queries, query)
	if strings.HasPrefix(query, "INSERT INTO") {
		c.state.inserted = true
		return driver.RowsAffected(1), nil
	}
	return driver.RowsAffected(0), nil
}

func (c *catalogVisibilityConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.state.queries = append(c.state.queries, query)
	switch {
	case query == "SELECT CAST(@@GLOBAL.partial_revokes AS SIGNED)":
		return &catalogVisibilityRows{columns: []string{"partial_revokes"}, types: []string{"BIGINT"}, values: [][]driver.Value{{c.state.partialRevokes}}}, nil
	case query == "SELECT CURRENT_USER()":
		return &catalogVisibilityRows{columns: []string{"CURRENT_USER()"}, types: []string{"VARCHAR"}, values: [][]driver.Value{{"orm@localhost"}}}, nil
	case strings.Contains(query, "information_schema.USER_PRIVILEGES"):
		values := [][]driver.Value{}
		if c.state.directGrant {
			values = append(values, []driver.Value{"TRIGGER"})
		}
		return &catalogVisibilityRows{columns: []string{"PRIVILEGE_TYPE"}, types: []string{"VARCHAR"}, values: values}, nil
	case strings.HasPrefix(query, "SELECT ENGINE"):
		return &catalogVisibilityRows{columns: []string{"ENGINE"}, types: []string{"VARCHAR"}, values: [][]driver.Value{{"InnoDB"}}}, nil
	case strings.HasPrefix(query, "SELECT TRIGGER_NAME"):
		return &catalogVisibilityRows{columns: []string{"TRIGGER_NAME"}, types: []string{"VARCHAR"}}, nil
	case strings.HasPrefix(query, "SELECT TABLE_TYPE"):
		return &catalogVisibilityRows{columns: []string{"TABLE_TYPE"}, types: []string{"VARCHAR"}, values: [][]driver.Value{{"BASE TABLE"}}}, nil
	case strings.HasPrefix(query, "SELECT c.COLUMN_NAME"):
		return &catalogVisibilityRows{
			columns: []string{"COLUMN_NAME", "COLUMN_TYPE", "IS_NULLABLE", "GENERATED", "ORDINAL_POSITION", "AUTO_KEY", "COLUMN_DEFAULT", "EXPRESSION_DEFAULT"},
			types:   []string{"VARCHAR", "VARCHAR", "BIGINT", "BIGINT", "BIGINT", "BIGINT", "VARCHAR", "BIGINT"},
			values: [][]driver.Value{
				{"id", "BIGINT", int64(0), int64(0), int64(1), int64(0), nil, int64(0)},
				{"value", "VARCHAR(32)", int64(0), int64(0), int64(0), int64(0), nil, int64(0)},
			},
		}, nil
	case strings.HasPrefix(query, "SELECT `id`,`value` FROM"):
		values := [][]driver.Value{}
		if c.state.inserted {
			values = append(values, []driver.Value{int64(1), "visible"})
		}
		return &catalogVisibilityRows{columns: []string{"id", "value"}, types: []string{"BIGINT", "VARCHAR"}, values: values}, nil
	default:
		return nil, errors.New("unexpected catalog visibility query: " + query)
	}
}

type catalogVisibilityTx struct{}

func (catalogVisibilityTx) Commit() error   { return nil }
func (catalogVisibilityTx) Rollback() error { return nil }

type catalogVisibilityRows struct {
	columns []string
	types   []string
	values  [][]driver.Value
	index   int
}

func (r catalogVisibilityRows) Columns() []string { return r.columns }
func (r catalogVisibilityRows) Close() error      { return nil }
func (r catalogVisibilityRows) ColumnTypeDatabaseTypeName(index int) string {
	return r.types[index]
}
func (r *catalogVisibilityRows) Next(destination []driver.Value) error {
	if r.index == len(r.values) {
		return io.EOF
	}
	copy(destination, r.values[r.index])
	r.index++
	return nil
}

// Requirements: INT-119.
func TestCatalogInsertVerifiesMySQLTriggerVisibility(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	metadata := CatalogTableMetadata{
		Table: CatalogTableRef{Namespace: "app", Name: "visibility_probe"},
		Kind:  CatalogKindTable,
		Columns: []CatalogColumn{
			{Name: "id", NativeType: "BIGINT"},
			{Name: "value", NativeType: "VARCHAR(32)"},
		},
		PrimaryKey:          []string{"id"},
		ReliableRowIdentity: true,
	}
	for _, scenario := range []struct {
		name           string
		partialRevokes int64
		directGrant    bool
		wantSuccess    bool
	}{
		{name: "direct grant", directGrant: true, wantSuccess: true},
		{name: "role-only grant", directGrant: false},
		{name: "partial revokes", partialRevokes: 1, directGrant: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			state := &catalogVisibilityState{partialRevokes: scenario.partialRevokes, directGrant: scenario.directGrant}
			pool := sql.OpenDB(catalogVisibilityConnector{state: state})
			pool.SetMaxOpenConns(1)
			t.Cleanup(func() { testcase.Close(t, pool) })
			catalog := &CatalogConnection{db: &DB{sql: pool}, dialect: "mysql"}
			result, err := catalog.InsertRow(context.Background(), metadata, []CatalogAssignment{
				{Name: "id", Value: int64(1)},
				{Name: "value", Value: "visible"},
			})
			if scenario.wantSuccess {
				if err != nil || !reflect.DeepEqual(result.Rows, [][]any{{int64(1), "visible"}}) {
					t.Fatalf("direct grant insert = %#v, %v", result, err)
				}
				if !slices.ContainsFunc(state.queries, func(query string) bool { return strings.HasPrefix(query, "INSERT INTO") }) {
					t.Fatal("direct grant did not reach the catalog insert")
				}
				return
			}
			if ErrorCode(err) != CodeRowMutationUnsupported {
				t.Fatalf("insert error = %v, want %s", err, CodeRowMutationUnsupported)
			}
			if slices.ContainsFunc(state.queries, func(query string) bool { return strings.HasPrefix(query, "INSERT INTO") }) {
				t.Fatalf("rejected visibility state wrote a row: %v", state.queries)
			}
			if scenario.partialRevokes == 1 && slices.Contains(state.queries, "SELECT CURRENT_USER()") {
				t.Fatalf("partial revokes were rejected only after privilege lookup: %v", state.queries)
			}
			if !scenario.directGrant && !slices.ContainsFunc(state.queries, func(query string) bool { return strings.Contains(query, "information_schema.USER_PRIVILEGES") }) {
				t.Fatalf("role-only privilege was not checked in direct grant views: %v", state.queries)
			}
		})
	}
}
