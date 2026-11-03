package recipe

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/testcase"
)

// applyNow is the fixed clock of the dbspec apply ops (FCV-4), 2023-11-14T22:13:20Z.
var applyNow = func() time.Time { return time.UnixMicro(1_700_000_000_000_000).UTC() }

// applyRules are the statements that a dbspec.connect runs on a direct connection, as every client does on a new one.
var applyRules = map[string][]string{
	"mysql":    {"SET time_zone = '+00:00'"},
	"postgres": {"SET TimeZone = 'UTC'"},
	"sqlite":   {"PRAGMA foreign_keys = ON"},
}

// applyServerEnv names the variable of the server that the apply connections reach directly (PLN-105).
var applyServerEnv = map[string]string{"mysql": "ORM_TEST_MYSQL_SERVER_DSN", "postgres": "ORM_TEST_POSTGRES_SERVER_DSN"}

// applyDialects are the dialects of the public apply API.
var applyDialects = map[string]dbspec.Dialect{"mysql": dbspec.DialectMySQL, "postgres": dbspec.DialectPostgres, "sqlite": dbspec.DialectSQLite}

// applyOps are the ops of FCV-4 that drive the public apply API on named connections.
var applyOps = map[string]bool{
	"dbspec.plan": true, "dbspec.connect": true, "dbspec.exec": true, "dbspec.other_database": true,
	"dbspec.apply": true, "dbspec.recover": true, "dbspec.rollback": true, "dbspec.finalize": true,
}

// applyOn is the on field of an apply command.
type applyOn struct {
	Event string            `json:"event"`
	Every bool              `json:"every"`
	Steps []json.RawMessage `json:"steps"`
}

// openApplyConnection opens the one session of a named connection on database, and closes it when the case ends.
func openApplyConnection(c *databaseContext, dsn string) (*sql.Conn, func() error, error) {
	pool := testdb.Open(c.t, c.database, dsn)
	conn, err := pool.Conn(c.ctx)
	if err != nil {
		testcase.Close(c.t, pool)
		return nil, nil, err
	}
	return conn, func() error { return errors.Join(conn.Close(), pool.Close()) }, nil
}

// applyDirectDSN is the DSN of the direct connections to the case database name, or a failure when its variable is missing.
func applyDirectDSN(c *databaseContext, dsn string) (string, error) {
	if c.database == "sqlite" {
		return dsn, nil
	}
	server := os.Getenv(applyServerEnv[c.database])
	if server == "" {
		return "", fmt.Errorf("%s is required; database tests never skip", applyServerEnv[c.database])
	}
	return testdb.Retarget(c.t, server, testdb.DatabaseOf(c.t, dsn)), nil
}

// applyPoolerDSN is the DSN of the case database through the transaction pooler, with the simple protocol: a server
// connection behind the pooler can change with each statement, so prepared statements are not used.
func applyPoolerDSN(c *databaseContext) (string, error) {
	pooler := os.Getenv("ORM_TEST_PGBOUNCER_DSN")
	if pooler == "" {
		return "", errors.New("ORM_TEST_PGBOUNCER_DSN is required; database tests never skip")
	}
	u, err := url.Parse(testdb.Retarget(c.t, pooler, testdb.DatabaseOf(c.t, c.dsn)))
	if err != nil {
		return "", err
	}
	query := u.Query()
	query.Set("default_query_exec_mode", "simple_protocol")
	u.RawQuery = query.Encode()
	return u.String(), nil
}

// applyOp runs one op of applyOps.
func applyOp(s databaseStep, c *databaseContext) (outcome, error) {
	switch s.Op {
	case "dbspec.plan":
		plan, diagnostics := dbspec.ParsePlan(strings.Join(s.Lines, "\n") + "\n")
		if plan == nil {
			return outcome{}, fmt.Errorf("dbspec.plan %s: %v", s.As, diagnostics)
		}
		return outcome{api: plan}, nil
	case "dbspec.connect":
		dsn, err := applyDirectDSN(c, c.dsn)
		if s.Through == "pooler" {
			dsn, err = applyPoolerDSN(c)
		}
		if err != nil {
			return outcome{}, err
		}
		conn, closeConn, err := openApplyConnection(c, dsn)
		if err != nil {
			return outcome{}, err
		}
		c.closers = append(c.closers, closeConn)
		if s.Through == "" {
			for _, rule := range applyRules[c.database] {
				if _, err := conn.ExecContext(c.ctx, rule); err != nil {
					return outcome{}, err
				}
			}
		}
		return outcome{api: conn}, nil
	case "dbspec.exec":
		return applyExec(s, c)
	case "dbspec.other_database":
		other := testdb.New(c.t, c.database)
		dsn, err := applyDirectDSN(c, other)
		if err != nil {
			return outcome{}, err
		}
		conn, closeConn, err := openApplyConnection(c, dsn)
		if err != nil {
			return outcome{}, err
		}
		defer func() {
			if err := closeConn(); err != nil {
				c.t.Errorf("close the other database: %v", err)
			}
		}()
		for _, rule := range applyRules[c.database] {
			if _, err := conn.ExecContext(c.ctx, rule); err != nil {
				return outcome{}, err
			}
		}
		c.bound[s.As] = bound{api: conn}
		return okOutcome(), runNested(s.Steps, c)
	}
	return applyCommand(s, c)
}

// applySession is the named connection of a step.
func applySession(name string, c *databaseContext) (*sql.Conn, error) {
	b, ok := c.bound[name]
	if !ok {
		return nil, fmt.Errorf("connection %q is not bound", name)
	}
	conn, ok := b.api.(*sql.Conn)
	if !ok {
		return nil, fmt.Errorf("connection %q is a %T, not a dbspec.connect connection", name, b.api)
	}
	return conn, nil
}

// applyExec runs the statement of dbspec.exec on its named connection, and its value is the rows with every cell as text.
func applyExec(s databaseStep, c *databaseContext) (outcome, error) {
	conn, err := applySession(s.Connection, c)
	if err != nil {
		return outcome{}, err
	}
	statement, present, err := sqlExecText(s.SQL, c)
	if err != nil {
		return outcome{}, err
	}
	if !present {
		return outcome{}, fmt.Errorf("dbspec.exec has no statement for %s", c.database)
	}
	statement = strings.ReplaceAll(statement, "{step}", strconv.Itoa(c.applyStep))
	rows, err := conn.QueryContext(c.ctx, statement)
	if err != nil {
		return outcome{}, err
	}
	defer testcase.Close(c.t, rows)
	columns, err := rows.Columns()
	if err != nil {
		return outcome{}, err
	}
	list := []any{}
	for rows.Next() {
		cells := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range cells {
			pointers[i] = &cells[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return outcome{}, err
		}
		row := []any{}
		for _, cell := range cells {
			switch v := cell.(type) {
			case nil:
				row = append(row, map[string]any{"null": true})
			case []byte:
				row = append(row, map[string]any{"text": string(v)})
			default:
				row = append(row, map[string]any{"text": fmt.Sprint(v)})
			}
		}
		list = append(list, map[string]any{"array": row})
	}
	if err := rows.Err(); err != nil {
		return outcome{}, err
	}
	return outcome{fields: map[string]any{"value": map[string]any{"array": list}}}, nil
}

// applyCommand makes one call of Apply, Recover, Rollback or Finalize, and its value is the code of its failure, or ok, and
// the number of events of the kind that count names. Steps of on run inside the event handler.
func applyCommand(s databaseStep, c *databaseContext) (outcome, error) {
	conn, err := applySession(s.Connection, c)
	if err != nil {
		return outcome{}, err
	}
	plans := []*dbspec.Plan{}
	for _, name := range s.Plans {
		plan, ok := c.bound[name].api.(*dbspec.Plan)
		if !ok {
			return outcome{}, fmt.Errorf("plan %q is not bound", name)
		}
		plans = append(plans, plan)
	}
	events, ran := 0, false
	handler := func(ev dbspec.ApplyEvent) error {
		if s.Count == "" || s.Count == ev.Kind {
			events++
		}
		if s.On == nil || s.On.Event != ev.Kind || (ran && !s.On.Every) {
			return nil
		}
		ran = true
		c.applyStep = ev.Step
		return runNested(s.On.Steps, c)
	}
	dialect := applyDialects[c.database]
	switch s.Op {
	case "dbspec.apply":
		var res dbspec.ApplyResult
		res, err = dbspec.Apply(c.ctx, conn, dialect, plans, applyNow, handler)
		if err == nil && res.Failure != nil {
			err = res.Failure
		} else if err == nil && res.Stopped {
			err = res.Stop
		}
	case "dbspec.recover":
		err = dbspec.Recover(c.ctx, conn, dialect, plans, applyNow, handler)
	case "dbspec.rollback":
		err = dbspec.Rollback(c.ctx, conn, dialect, plans, applyNow, handler)
	case "dbspec.finalize":
		err = dbspec.Finalize(c.ctx, conn, dialect, plans, applyNow, handler)
	}
	code := "ok"
	if err != nil {
		var failure *dbspec.ApplyError
		if !errors.As(err, &failure) {
			return outcome{}, err
		}
		code = failure.Code
		if s.Detail != "" && !strings.Contains(failure.Message, s.Detail) {
			return outcome{}, fmt.Errorf("the message %q does not hold %q", failure.Message, s.Detail)
		}
	}
	return outcome{fields: map[string]any{"value": map[string]any{"object": []any{
		[]any{"code", map[string]any{"text": code}},
		[]any{"events", map[string]any{"int": strconv.Itoa(events)}},
	}}}}, nil
}
