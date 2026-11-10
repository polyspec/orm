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
	"dbspec.apply": true, "dbspec.recover": true, "dbspec.rollback": true, "dbspec.finalize": true, "dbspec.schema": true,
}

// applyOn is the on field of an apply command.
type applyOn struct {
	Event string            `json:"event"`
	Plan  string            `json:"plan"`
	Step  *int              `json:"step"`
	Every bool              `json:"every"`
	Stop  bool              `json:"stop"`
	Steps []json.RawMessage `json:"steps"`
}

// applyElapsed is the elapsed field of an apply command.
type applyElapsed struct {
	AtLeastMs int64 `json:"at_least_ms"`
	BelowMs   int64 `json:"below_ms"`
}

// errApplyStop is what an on with stop returns from the event handler, so the code of the command is stopped.
var errApplyStop = errors.New("the recipe stops the command")

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
	if c.dialect() == "sqlite" {
		return dsn, nil
	}
	// On MariaDB the variable of the MySQL dialect names the MariaDB server (FCV-3).
	variable := serverVariable(applyServerEnv[c.dialect()], c.database)
	server := os.Getenv(variable)
	if server == "" {
		return "", fmt.Errorf("%s is required; run make orm-test-servers, which starts the databases and writes it", variable)
	}
	return testdb.Retarget(c.t, server, testdb.DatabaseOf(c.t, dsn)), nil
}

// applyPoolerDSN is the DSN of the case database through the transaction pooler, with the simple protocol: a server
// connection behind the pooler can change with each statement, so prepared statements are not used.
func applyPoolerDSN(c *databaseContext) (string, error) {
	pooler := os.Getenv("ORM_TEST_PGBOUNCER_DSN")
	if pooler == "" {
		return "", errors.New("ORM_TEST_PGBOUNCER_DSN is required; run make orm-test-servers, which starts the databases and writes it")
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
	switch s.k("op").Op {
	case "dbspec.plan":
		plan, diagnostics := dbspec.ParsePlan(strings.Join(s.k("lines").Lines, "\n") + "\n")
		if plan == nil {
			return outcome{}, fmt.Errorf("dbspec.plan %s: %v", s.k("as").As, diagnostics)
		}
		return outcome{api: plan}, nil
	case "dbspec.connect":
		dsn, err := applyDirectDSN(c, c.dsn)
		if s.k("through").Through == "pooler" {
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
		if s.k("through").Through == "" {
			for _, rule := range applyRules[c.dialect()] {
				if _, err := conn.ExecContext(c.ctx, rule); err != nil {
					return outcome{}, err
				}
			}
		}
		return outcome{api: conn}, nil
	case "dbspec.exec":
		return applyExec(s, c)
	case "dbspec.schema":
		return applySchema(s, c)
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
		for _, rule := range applyRules[c.dialect()] {
			if _, err := conn.ExecContext(c.ctx, rule); err != nil {
				return outcome{}, err
			}
		}
		c.bound[s.k("as").As] = bound{api: conn}
		return okOutcome(), runNested(s.k("steps").Steps, c)
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

// applySchema introspects the database of the named connection; its value is the schema text of the manifest, empty with no table.
func applySchema(s databaseStep, c *databaseContext) (outcome, error) {
	conn, err := applySession(s.k("connection").Connection, c)
	if err != nil {
		return outcome{}, err
	}
	document, unsupported, err := dbspec.Introspect(c.ctx, conn, applyDialects[c.dialect()], c.server(), "x")
	if err != nil {
		return outcome{}, err
	}
	if len(unsupported) > 0 {
		return outcome{}, fmt.Errorf("dbspec.schema: unsupported %+v", unsupported)
	}
	text := ""
	if len(document.Tables) > 0 {
		manifest, _ := dbspec.ManifestOf([]*dbspec.Document{document})
		text = manifest.SchemaText
	}
	return outcome{fields: map[string]any{"value": map[string]any{"text": text}}}, nil
}

// applyExec runs the statement of dbspec.exec on its named connection, and its value is the rows with every cell as text.
func applyExec(s databaseStep, c *databaseContext) (outcome, error) {
	conn, err := applySession(s.k("connection").Connection, c)
	if err != nil {
		return outcome{}, err
	}
	statement, present, err := sqlExecText(s.k("sql").SQL, c)
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
	conn, err := applySession(s.k("connection").Connection, c)
	if err != nil {
		return outcome{}, err
	}
	plans := []*dbspec.Plan{}
	for _, name := range s.k("plans").Plans {
		plan, ok := c.bound[name].api.(*dbspec.Plan)
		if !ok {
			return outcome{}, fmt.Errorf("plan %q is not bound", name)
		}
		plans = append(plans, plan)
	}
	events, kinds, ran := 0, map[string]int{}, false
	handler := func(ev dbspec.ApplyEvent) error {
		if c.progress != nil {
			c.progress()
		}
		events++
		kinds[ev.Kind]++
		if s.k("on").On == nil || s.k("on").On.Event != ev.Kind || (ran && !s.k("on").On.Every) {
			return nil
		}
		if (s.k("on").On.Plan != "" && s.k("on").On.Plan != ev.Plan) || (s.k("on").On.Step != nil && *s.k("on").On.Step != ev.Step) {
			return nil
		}
		ran = true
		c.applyStep = ev.Step
		if err := runNested(s.k("on").On.Steps, c); err != nil {
			return err
		}
		if s.k("on").On.Stop {
			return errApplyStop
		}
		return nil
	}
	started := time.Now()
	dialect := applyDialects[c.dialect()]
	switch s.k("op").Op {
	case "dbspec.apply":
		var res dbspec.ApplyResult
		res, err = dbspec.Apply(c.ctx, conn, dialect, c.server(), plans, applyNow, handler)
		if err == nil && res.Failure != nil {
			err = res.Failure
		} else if err == nil && res.Stopped {
			err = res.Stop
		}
	case "dbspec.recover":
		err = dbspec.Recover(c.ctx, conn, dialect, c.server(), plans, applyNow, handler)
	case "dbspec.rollback":
		err = dbspec.Rollback(c.ctx, conn, dialect, c.server(), plans, applyNow, handler)
	case "dbspec.finalize":
		err = dbspec.Finalize(c.ctx, conn, dialect, c.server(), plans, applyNow, handler)
	}
	elapsed := time.Since(started).Milliseconds()
	code := "ok"
	if err != nil {
		var failure *dbspec.ApplyError
		switch {
		case errors.Is(err, errApplyStop):
			code = "stopped"
		case errors.As(err, &failure):
			code = failure.Code
		case s.k("message").Message != "" && err.Error() == s.k("message").Message:
			code = "message"
		default:
			return outcome{}, err
		}
		if s.k("detail").Detail != "" && !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(s.k("detail").Detail)) {
			return outcome{}, fmt.Errorf("the message %q does not hold %q", err.Error(), s.k("detail").Detail)
		}
		if err := s.k("message_holds").MessageHolds.check(err.Error()); err != nil {
			return outcome{}, err
		}
	}
	if s.k("elapsed").Elapsed != nil && (elapsed < s.k("elapsed").Elapsed.AtLeastMs || elapsed >= s.k("elapsed").Elapsed.BelowMs) {
		return outcome{}, fmt.Errorf("the command took %d ms, want at least %d and below %d", elapsed, s.k("elapsed").Elapsed.AtLeastMs, s.k("elapsed").Elapsed.BelowMs)
	}
	members := []any{[]any{"code", map[string]any{"text": code}}}
	if s.k("count").Count == nil {
		members = append(members, []any{"events", map[string]any{"int": strconv.Itoa(events)}})
	}
	for _, kind := range s.k("count").Count {
		members = append(members, []any{kind, map[string]any{"int": strconv.Itoa(kinds[kind])}})
	}
	if s.k("with_message").WithMessage && err != nil {
		members = append(members, []any{"message", map[string]any{"text": err.Error()}})
	}
	return outcome{fields: map[string]any{"value": map[string]any{"object": members}}}, nil
}
