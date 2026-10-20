package dbspec

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// Execer is the one connection on which the command runs statements and reads the catalog.
// *sql.Conn satisfies it, and the command uses the lock and session settings only on that connection.
type Execer interface {
	Querier
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// ApplyEvent is what apply, recover, rollback, and finalize report (docs/spec/plans.md
// "Apply"). Kind is one of plan, rollback, finalize, irreversible, statement, applied,
// verified, or done.
type ApplyEvent struct {
	Kind      string
	Plan      string
	Step      int
	Steps     int
	Statement string
}

// ApplyError is a failure of the command. Code is one of locked, session, interrupted, drift, chain, failed,
// verify, irreversible, or nulls.
type ApplyError struct {
	Code    string
	Plan    string
	Step    int
	Message string
	Err     error
}

func (e *ApplyError) Error() string {
	s := e.Code
	if e.Plan != "" {
		s += " " + e.Plan
	}
	switch e.Code {
	case "failed", "interrupted", "irreversible", "nulls":
		s += fmt.Sprintf(" at step %d", e.Step)
	case "session":
		if e.Plan != "" {
			s += fmt.Sprintf(" at step %d", e.Step)
		}
	}
	if e.Message != "" {
		s += ": " + e.Message
	}
	if e.Err != nil {
		s += ": " + e.Err.Error()
	}
	return s
}

func (e *ApplyError) Unwrap() error { return e.Err }

// historyTable is the table that records applied plans. Since dbspec names have no $, it does not
// collide with user tables, and introspection reads excluding tables that start with dbspec$.
const historyTable = "dbspec$plans"

// mysqlLockName is the lock name of the current database. A MySQL lock name is
// up to 64 characters, so it uses the first 51 characters of the SHA-256 hex of the database name, not the name itself, to make 64.
const mysqlLockName = "CONCAT('" + historyTable + "$', LEFT(SHA2(DATABASE(), 256), 51))"

// postgresLockKey is the advisory lock key of the current schema of the current database.
const postgresLockKey = "hashtext('" + historyTable + "'), hashtext(current_schema())"

// sessionRequirement is the requirement that the session error states. The lock belongs to the server session, so the command
// must run from start to finish on one server session that is not shared with other clients. A transaction
// pooler picks a server connection again for each statement, so it cannot keep that requirement.
const sessionRequirement = "apply, recover, rollback and finalize need one server session of their own for the whole run: a direct or session-pooled connection"

// mysqlSessionQuery and postgresSessionQuery read the id of the current server session, and whether that session
// already holds the lock, before the lock is taken. If it is already held, another client is using the same server
// session.
const (
	mysqlSessionQuery    = "SELECT CONNECTION_ID(), COALESCE(IS_USED_LOCK(" + mysqlLockName + ") = CONNECTION_ID(), 0)"
	postgresSessionQuery = "SELECT pg_backend_pid(), EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND objsubid = 2" +
		" AND classid = (hashtext('" + historyTable + "')::bigint & 4294967295)::oid AND objid = (hashtext(current_schema())::bigint & 4294967295)::oid)"
)

// lockWait is the maximum time a statement waits for another session's lock (docs/spec/plans.md
// "Apply" lock wait).
const (
	lockWaitSeconds = 5
	lockWaitMillis  = lockWaitSeconds * 1000
)

// state of the history row.
const (
	stateApplying    = "applying"
	stateApplied     = "applied"
	stateFinalizing  = "finalizing"
	stateDone        = "done"
	stateRollingBack = "rolling_back"
)

// applier is the state of one command.
type applier struct {
	ctx     context.Context
	c       Execer
	r       renderer
	now     func() time.Time
	events  func(ApplyEvent) error
	chain   []*Plan
	history map[string]historyRow
	// serverSession is the id of the server session holding the lock (MySQL CONNECTION_ID, PostgreSQL pg_backend_pid).
	serverSession int64
}

type historyRow struct {
	from, to, state string
	step            int
}

func newApplier(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error) (*applier, error) {
	switch dialect {
	case DialectMySQL, DialectPostgres, DialectSQLite:
	default:
		panic("dbspec: unknown dialect " + string(dialect))
	}
	chain, diagnostics := Chain(plans)
	if len(diagnostics) > 0 {
		return nil, &ApplyError{Code: "chain", Message: diagnostics[0].Message}
	}
	return &applier{ctx: ctx, c: c, r: renderer{d: dialect}, now: now, events: events, chain: chain}, nil
}

// ApplyResult is how an Apply run ended, apart from the error Apply returns.
type ApplyResult struct {
	// Stopped is true when the events callback returned an error, which ended the run there. Stop is that error.
	Stopped bool
	Stop    error
	// Failure is the ApplyError that ended the run, when that error is the only failure of the run.
	Failure *ApplyError
}

// Apply applies, in chain order, the plans the database has not yet applied, up to the finalize step.
// It changes nothing on a database that is already applied to the end.
//
// A stop by an event alone is reported by Stopped with a nil error, and an ApplyError alone is reported by Failure
// with a nil error. The error is non-nil for any other failure, and for a cleanup failure after a stop or a failure,
// which is returned joined with it.
func Apply(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error) (ApplyResult, error) {
	var res ApplyResult
	if events != nil {
		callback := events
		events = func(ev ApplyEvent) error {
			err := callback(ev)
			if err != nil && !res.Stopped {
				res.Stopped, res.Stop = true, err
			}
			return err
		}
	}
	a, err := newApplier(ctx, c, dialect, plans, now, events)
	if err == nil {
		err = a.session(func() error {
			position, err := a.settled()
			if err != nil {
				return err
			}
			for _, p := range a.chain[position:] {
				if err := a.applyPlan(p); err != nil {
					return err
				}
			}
			return nil
		})
	}
	if isOnly(err, res.Stop) {
		err = nil
	}
	if err != nil && unjoined(err) {
		var applyErr *ApplyError
		if errors.As(err, &applyErr) {
			res.Failure = applyErr
			err = nil
		}
	}
	return res, err
}

// unjoined reports whether err is not an errors.Join of several errors, which is how a cleanup failure is returned
// together with the failure before it.
func unjoined(err error) bool {
	_, joined := err.(interface{ Unwrap() []error })
	return !joined
}

// isOnly reports whether err is the target error by itself, with no cleanup failure joined to it.
func isOnly(err, target error) bool {
	return target != nil && err != nil && unjoined(err) && errors.Is(err, target)
}

// Recover judges an interrupted plan from the effects in the catalog and carries it forward. If there is no
// interrupted plan, it changes nothing.
func Recover(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error) error {
	return lastPlan(ctx, c, dialect, plans, now, events, func(a *applier, p *Plan, row historyRow) error {
		if row.state == stateApplied || row.state == stateDone {
			return nil
		}
		steps, err := a.steps(p)
		if err != nil {
			return err
		}
		k, err := a.resolve(p, row, steps, true)
		if err != nil {
			return err
		}
		if row.state == stateFinalizing {
			if err := a.emit(ApplyEvent{Kind: "finalize", Plan: p.Name, Steps: len(steps)}); err != nil {
				return err
			}
			return a.finalizeFrom(p, steps, k)
		}
		if err := a.emit(ApplyEvent{Kind: "plan", Plan: p.Name, Steps: len(steps)}); err != nil {
			return err
		}
		if err := a.record(p, stateApplying, k); err != nil {
			return err
		}
		return a.forward(p, steps, k)
	})
}

// Rollback rolls the last plan in history back to step 0 with its rollback statements, and then
// deletes its row. If there is no row, it changes nothing.
func Rollback(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error) error {
	return lastPlan(ctx, c, dialect, plans, now, events, func(a *applier, p *Plan, row historyRow) error {
		steps, err := a.steps(p)
		if err != nil {
			return err
		}
		k := row.step
		applied := row.state == stateApplied || row.state == stateDone
		if applied {
			if k < 0 || k > len(steps) {
				return &ApplyError{Code: "chain", Plan: p.Name, Message: fmt.Sprintf("the recorded step %d is outside the plan's %d steps", k, len(steps))}
			}
			if err := a.verify(p.To); err != nil {
				return &ApplyError{Code: "drift", Plan: p.Name, Message: err.Error()}
			}
		} else if k, err = a.resolve(p, row, steps, false); err != nil {
			return err
		}
		if k > 0 && steps[k-1].Rollback == "" {
			return a.irreversible(p, steps, k-1)
		}
		if applied {
			if err := a.nullChecks(p, steps[:k]); err != nil {
				return err
			}
		}
		if err := a.emit(ApplyEvent{Kind: "rollback", Plan: p.Name, Steps: len(steps)}); err != nil {
			return err
		}
		if err := a.record(p, stateRollingBack, k); err != nil {
			return err
		}
		for i := k - 1; i >= 0; i-- {
			if steps[i].Rollback == "" {
				return a.irreversible(p, steps, i)
			}
			statement, err := a.statementAt(p, i, steps[i].Rollback, steps[i].RollbackRestore, steps[i].RestoreIf)
			if err != nil {
				return err
			}
			if err := a.runAndRecord(p, steps, i, statement, i); err != nil {
				return err
			}
		}
		if err := a.foreignKeyCheck(p); err != nil {
			return err
		}
		if err := a.verified(p, p.From, len(steps)); err != nil {
			return err
		}
		q := a.r.q
		if _, err := a.c.ExecContext(a.ctx, "DELETE FROM "+q(historyTable)+" WHERE "+q("name")+" = "+a.placeholder(1), p.Name); err != nil {
			return err
		}
		return a.emit(ApplyEvent{Kind: "done", Plan: p.Name, Steps: len(steps)})
	})
}

// Finalize runs the finalize steps of all applied plans in chain order, deleting hidden tables and
// columns.
func Finalize(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error) error {
	return inSession(ctx, c, dialect, plans, now, events, func(a *applier) error {
		position, err := a.settled()
		if err != nil {
			return err
		}
		for _, p := range a.chain[:position] {
			if a.history[p.Name].state != stateApplied {
				continue
			}
			steps, err := a.steps(p)
			if err != nil {
				return err
			}
			if err := a.emit(ApplyEvent{Kind: "finalize", Plan: p.Name, Steps: len(steps)}); err != nil {
				return err
			}
			start := finalizeStart(steps)
			if err := a.record(p, stateFinalizing, start); err != nil {
				return err
			}
			if err := a.finalizeFrom(p, steps, start); err != nil {
				return err
			}
		}
		return nil
	})
}

// finalizeStart is the index of the first finalize step.
func finalizeStart(steps []PlanStep) int {
	for i, s := range steps {
		if s.Finalize {
			return i
		}
	}
	return len(steps)
}

func (a *applier) irreversible(p *Plan, steps []PlanStep, i int) error {
	message := steps[i].Irreversible
	if steps[i].Finalize {
		message = "a finalize step has no rollback"
	}
	return &ApplyError{Code: "irreversible", Plan: p.Name, Step: i, Message: message}
}

// inSession runs fn in a session of the applier of plans; the applier is
// created with the plans and the arguments of the caller.
func inSession(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error, fn func(a *applier) error) error {
	a, err := newApplier(ctx, c, dialect, plans, now, events)
	if err != nil {
		return err
	}
	return a.session(func() error { return fn(a) })
}

// lastPlan runs fn in a session of the applier of plans, with the last plan of
// the history chain and its history row. With no recorded plan it changes
// nothing.
func lastPlan(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error, fn func(a *applier, p *Plan, row historyRow) error) error {
	return inSession(ctx, c, dialect, plans, now, events, func(a *applier) error {
		position, err := a.position()
		if err != nil || position == 0 {
			return err
		}
		p := a.chain[position-1]
		return fn(a, p, a.history[p.Name])
	})
}

// session takes the dialect's lock and changes the session settings, runs f, and at the end restores the settings
// and releases the lock.
func (a *applier) session(f func() error) error {
	switch a.r.d {
	case DialectMySQL:
		if err := a.openSession(mysqlSessionQuery); err != nil {
			return err
		}
		var got sql.NullInt64
		var session int64
		if err := a.queryRow("SELECT GET_LOCK("+mysqlLockName+", 0), CONNECTION_ID()", &got, &session); err != nil {
			return err
		}
		// A NULL from GET_LOCK is an error raised while waiting for the lock.
		switch {
		case !got.Valid:
			return fmt.Errorf("GET_LOCK returned NULL; want 1 or 0")
		case got.Int64 != 0 && got.Int64 != 1:
			return fmt.Errorf("GET_LOCK returned %d; want 1 or 0", got.Int64)
		case got.Int64 == 0:
			return &ApplyError{Code: "locked", Message: "another session holds the " + historyTable + " lock of this database"}
		}
		var lockWait, rowWait int64
		err := a.sameSession(nil, 0, session)
		if err == nil {
			err = a.queryRow("SELECT @@SESSION.lock_wait_timeout, @@SESSION.innodb_lock_wait_timeout", &lockWait, &rowWait)
		}
		if err == nil {
			_, err = a.c.ExecContext(a.ctx, fmt.Sprintf("SET SESSION lock_wait_timeout = %d, innodb_lock_wait_timeout = %d", lockWaitSeconds, lockWaitSeconds))
			if err == nil {
				err = f()
				_, restore := a.c.ExecContext(a.ctx, fmt.Sprintf("SET SESSION lock_wait_timeout = %d, innodb_lock_wait_timeout = %d", lockWait, rowWait))
				err = joinCleanup(err, restore)
			}
		}
		_, unlock := a.c.ExecContext(a.ctx, "DO RELEASE_LOCK("+mysqlLockName+")")
		return joinCleanup(err, unlock)
	case DialectPostgres:
		// If current_schema() is NULL, the result is NULL too, and it is an error because it cannot be read as bool.
		if err := a.openSession(postgresSessionQuery); err != nil {
			return err
		}
		var got bool
		var session int64
		if err := a.queryRow("SELECT pg_try_advisory_lock("+postgresLockKey+"), pg_backend_pid()", &got, &session); err != nil {
			return err
		}
		if !got {
			return &ApplyError{Code: "locked", Message: "another session holds the " + historyTable + " advisory lock of this schema"}
		}
		var previous, set string
		err := a.sameSession(nil, 0, session)
		if err == nil {
			err = a.queryRow("SELECT current_setting('lock_timeout')", &previous)
		}
		if err == nil {
			err = a.queryRow(fmt.Sprintf("SELECT set_config('lock_timeout', '%ds', false)", lockWaitSeconds), &set)
			if err == nil {
				err = f()
				restore := a.queryRowArgs("SELECT set_config('lock_timeout', $1, false)", []any{previous}, &set)
				err = joinCleanup(err, restore)
			}
		}
		var released bool
		unlock := a.queryRow("SELECT pg_advisory_unlock("+postgresLockKey+")", &released)
		if unlock == nil && !released {
			unlock = fmt.Errorf("the advisory lock of %s was not held at unlock", historyTable)
		}
		return joinCleanup(err, unlock)
	}
	return a.sqliteSession(f)
}

// openSession remembers the id of the server session before the lock is taken. If that session already holds the
// lock, another client is using the same server session, so it is a session error.
func (a *applier) openSession(query string) error {
	var held bool
	if err := a.queryRow(query, &a.serverSession, &held); err != nil {
		return err
	}
	if held {
		return &ApplyError{Code: "session", Message: "this server session already holds the " + historyTable + " lock, so another client shares it; " + sessionRequirement}
	}
	return nil
}

// sameSession checks whether current is the server session holding the lock. If not, it is a session error
// before step i of plan p (or on the lock when p is nil).
func (a *applier) sameSession(p *Plan, i int, current int64) error {
	if current == a.serverSession {
		return nil
	}
	e := &ApplyError{Code: "session", Message: fmt.Sprintf("the connection moved from server session %d to %d; %s", a.serverSession, current, sessionRequirement)}
	if p != nil {
		e.Plan, e.Step = p.Name, i
	}
	return e
}

// checkSession checks, before a step, that the connection is still the server session holding the lock.
// A SQLite connection is the connection of one file, so it is not checked.
func (a *applier) checkSession(p *Plan, i int) error {
	query := map[Dialect]string{DialectMySQL: "SELECT CONNECTION_ID()", DialectPostgres: "SELECT pg_backend_pid()"}[a.r.d]
	if query == "" {
		return nil
	}
	var current int64
	if err := a.queryRow(query, &current); err != nil {
		return &ApplyError{Code: "failed", Plan: p.Name, Step: i, Message: query, Err: err}
	}
	return a.sameSession(p, i, current)
}

// sqliteSession locks the file in SQLite's exclusive locking mode, turns off foreign keys, and
// lets a rename carry other tables' foreign keys along.
func (a *applier) sqliteSession(f func() error) error {
	var foreignKeys, legacy, busy int64
	var mode string
	for _, read := range []struct {
		query string
		dest  any
	}{{"PRAGMA foreign_keys", &foreignKeys}, {"PRAGMA legacy_alter_table", &legacy}, {"PRAGMA busy_timeout", &busy}, {"PRAGMA locking_mode", &mode}} {
		if err := a.queryRow(read.query, read.dest); err != nil {
			return err
		}
	}
	exec := func(query string) error {
		_, err := a.c.ExecContext(a.ctx, query)
		return err
	}
	restore := func() []error {
		var tables int64
		return []error{
			exec("PRAGMA foreign_keys = " + strconv.FormatInt(foreignKeys, 10)),
			exec("PRAGMA legacy_alter_table = " + strconv.FormatInt(legacy, 10)),
			exec("PRAGMA locking_mode = " + mode),
			// After the locking mode is restored, one read is needed for the exclusive lock to be released.
			a.queryRow("SELECT COUNT(*) FROM sqlite_master", &tables),
			exec("PRAGMA busy_timeout = " + strconv.FormatInt(busy, 10)),
		}
	}
	if err := exec(fmt.Sprintf("PRAGMA busy_timeout = %d", lockWaitMillis)); err != nil {
		return err
	}
	if err := exec("PRAGMA locking_mode = EXCLUSIVE"); err != nil {
		return joinCleanup(append([]error{err}, restore()...)...)
	}
	if err := exec("BEGIN EXCLUSIVE"); err != nil {
		locked := &ApplyError{Code: "locked", Message: "another connection holds the SQLite database", Err: err}
		return joinCleanup(append([]error{locked}, restore()...)...)
	}
	err := exec("COMMIT")
	if err == nil {
		err = exec("PRAGMA foreign_keys = OFF")
	}
	if err == nil {
		err = exec("PRAGMA legacy_alter_table = OFF")
	}
	if err == nil {
		err = f()
	}
	return joinCleanup(append([]error{err}, restore()...)...)
}

// joinCleanup returns the failure together with the errors of the cleanup steps after it. When there is more than one
// non-nil error, it returns the error unwrapped if there is only one; if there are several, it holds them in order with errors.Join.
func joinCleanup(errs ...error) error {
	var found []error
	for _, err := range errs {
		if err != nil {
			found = append(found, err)
		}
	}
	if len(found) == 1 {
		return found[0]
	}
	return errors.Join(found...)
}

func (a *applier) queryRow(query string, dest ...any) error {
	return a.queryRowArgs(query, nil, dest...)
}

func (a *applier) queryRowArgs(query string, args []any, dest ...any) error {
	rows, err := a.c.QueryContext(a.ctx, query, args...)
	if err != nil {
		return err
	}
	if rows.Next() {
		err = rows.Scan(dest...)
	} else if err = rows.Err(); err == nil {
		err = fmt.Errorf("%s returned no row", query)
	}
	return joinCleanup(err, rows.Close())
}

// appliedAt is the applied_at text of history: the UTC time of the tool clock, truncated to six
// fractional digits, as YYYY-MM-DDTHH:MM:SS.ffffffZ (docs/spec/plans.md "Apply").
func appliedAt(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000000Z")
}

// createHistory creates the history table if it does not exist.
func (a *applier) createHistory() error {
	q := a.r.q
	integer, text, tail := "integer", "varchar(71)", ""
	if a.r.d == DialectMySQL {
		integer, text = "INT", "varchar(71) CHARACTER SET ascii COLLATE ascii_bin"
		tail = " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin"
	}
	_, err := a.c.ExecContext(a.ctx, "CREATE TABLE IF NOT EXISTS "+q(historyTable)+" ("+
		q("name")+" "+text+" NOT NULL, "+q("from_hash")+" "+text+" NOT NULL, "+q("to_hash")+" "+text+" NOT NULL, "+
		q("state")+" "+text+" NOT NULL, "+q("step")+" "+integer+" NOT NULL, "+q("steps")+" "+integer+" NOT NULL, "+
		q("applied_at")+" "+text+" NOT NULL, PRIMARY KEY ("+q("name")+"))"+tail)
	return err
}

func (a *applier) readHistory() error {
	if err := a.createHistory(); err != nil {
		return err
	}
	q := a.r.q
	a.history = map[string]historyRow{}
	return eachRow(a.ctx, a.c, "SELECT "+q("name")+", "+q("from_hash")+", "+q("to_hash")+", "+q("state")+", "+q("step")+" FROM "+q(historyTable), func(r scanner) error {
		var name string
		var row historyRow
		if err := r.Scan(&name, &row.from, &row.to, &row.state, &row.step); err != nil {
			return err
		}
		a.history[name] = row
		return nil
	})
}

// position reads history and returns the number of recorded plans. The records must be at the front of the chain,
// and the rows before the last must be applied or done.
func (a *applier) position() (int, error) {
	if err := a.readHistory(); err != nil {
		return 0, err
	}
	position := 0
	for i, p := range a.chain {
		row, ok := a.history[p.Name]
		switch {
		case !ok:
			continue
		case row.to != p.To || row.from != hashOrEmpty(p.From):
			return 0, &ApplyError{Code: "chain", Plan: p.Name, Message: "the recorded plan has other hashes than the chain's plan"}
		case i != position:
			return 0, &ApplyError{Code: "chain", Plan: p.Name, Message: "a plan before it in the chain is not recorded"}
		}
		switch row.state {
		case stateApplying, stateApplied, stateFinalizing, stateDone, stateRollingBack:
		default:
			return 0, &ApplyError{Code: "chain", Plan: p.Name, Message: "the recorded state " + row.state + " is not a history state"}
		}
		position = i + 1
	}
	if len(a.history) != position {
		return 0, &ApplyError{Code: "chain", Message: "the history records a plan that is not in the chain"}
	}
	for _, p := range a.chain[:max(position-1, 0)] {
		if s := a.history[p.Name].state; s != stateApplied && s != stateDone {
			return 0, &ApplyError{Code: "chain", Plan: p.Name, Message: "a plan before the last is " + s}
		}
	}
	return position, nil
}

// settled returns the number of recorded plans when no plan is interrupted and the catalog matches the recorded
// schema.
func (a *applier) settled() (int, error) {
	position, err := a.position()
	if err != nil {
		return 0, err
	}
	want := ""
	if position > 0 {
		p := a.chain[position-1]
		if row := a.history[p.Name]; row.state != stateApplied && row.state != stateDone {
			return 0, &ApplyError{Code: "interrupted", Plan: p.Name, Step: row.step, Message: "the plan is " + row.state + "; run recover or rollback"}
		}
		want = p.To
	}
	if err := a.verify(want); err != nil {
		return 0, &ApplyError{Code: "drift", Message: err.Error()}
	}
	return position, nil
}

// verified checks that the schema is want, and emits the event of a verified plan
// with its number of steps.
func (a *applier) verified(p *Plan, want string, steps int) error {
	if err := a.verify(want); err != nil {
		return &ApplyError{Code: "verify", Plan: p.Name, Err: err}
	}
	return a.emit(ApplyEvent{Kind: "verified", Plan: p.Name, Steps: steps})
}

// verify checks that the database's introspection equals want schemaHash (an empty string means an empty
// database) and that there are no unsupported objects.
func (a *applier) verify(want string) error {
	document, unsupported, err := Introspect(a.ctx, a.c, a.r.d, "schema")
	if err != nil {
		return err
	}
	if len(unsupported) > 0 {
		u := unsupported[0]
		return fmt.Errorf("the database has %d objects that dbspec cannot express, first %s %s %s: %s", len(unsupported), u.Kind, u.Table, u.Name, u.Reason)
	}
	got := ""
	if len(document.Tables) > 0 {
		manifest, diagnostics := ManifestOf([]*Document{document})
		if len(diagnostics) > 0 {
			return fmt.Errorf("the introspected schema is invalid: %v", diagnostics)
		}
		got = manifest.SchemaHash
	}
	if got != want {
		return fmt.Errorf("the database is at %s, not %s", hashOrEmpty(got), hashOrEmpty(want))
	}
	return nil
}

// steps writes the steps along the chain for a plan, using the target of the plan before it as source.
func (a *applier) steps(p *Plan) ([]PlanStep, error) {
	var source *Document
	for i, c := range a.chain {
		if c == p && i > 0 {
			source = a.chain[i-1].Schema
		}
	}
	steps, diagnostics := PlanSteps(source, p, a.r.d)
	if len(diagnostics) > 0 {
		return nil, &ApplyError{Code: "chain", Plan: p.Name, Message: diagnostics[0].Message}
	}
	return steps, nil
}

// resolve decides the step of an interrupted row from the effects in the catalog. It carries on forward if forward, otherwise
// backward (docs/spec/plans.md "Apply" recover).
func (a *applier) resolve(p *Plan, row historyRow, steps []PlanStep, forward bool) (int, error) {
	k := row.step
	if k < 0 || k > len(steps) {
		return 0, &ApplyError{Code: "chain", Plan: p.Name, Message: fmt.Sprintf("the recorded step %d is outside the plan's %d steps", k, len(steps))}
	}
	rolling := row.state == stateRollingBack
	uncertain := k
	if rolling {
		uncertain = k - 1
	}
	if uncertain < 0 || uncertain >= len(steps) {
		return k, nil
	}
	e := steps[uncertain].Effect
	held := false
	if e.Kind != "repeat" {
		var err error
		if held, err = a.effect(e); err != nil {
			return 0, &ApplyError{Code: "failed", Plan: p.Name, Step: uncertain, Err: err}
		}
	}
	// When going forward, repeat steps run again; when going backward, their rollback runs again.
	took := held || (!forward && e.Kind == "repeat")
	if rolling {
		if took {
			return k, nil
		}
		return k - 1, nil
	}
	if took {
		return k + 1, nil
	}
	return k, nil
}

// record writes the plan's row with state and step. If there is no row, it creates one.
func (a *applier) record(p *Plan, state string, step int) error {
	q := a.r.q
	if _, ok := a.history[p.Name]; !ok {
		steps, err := a.steps(p)
		if err != nil {
			return err
		}
		_, err = a.c.ExecContext(a.ctx, "INSERT INTO "+q(historyTable)+" ("+q("name")+", "+q("from_hash")+", "+q("to_hash")+", "+
			q("state")+", "+q("step")+", "+q("steps")+", "+q("applied_at")+") VALUES ("+a.placeholders(7)+")",
			p.Name, hashOrEmpty(p.From), p.To, state, step, len(steps), appliedAt(a.now()))
		if err == nil {
			a.history[p.Name] = historyRow{from: hashOrEmpty(p.From), to: p.To, state: state, step: step}
		}
		return err
	}
	_, err := a.c.ExecContext(a.ctx, "UPDATE "+q(historyTable)+" SET "+q("state")+" = "+a.placeholder(1)+", "+q("step")+" = "+a.placeholder(2)+
		" WHERE "+q("name")+" = "+a.placeholder(3), state, step, p.Name)
	return err
}

func (a *applier) setStep(p *Plan, step int) error {
	q := a.r.q
	_, err := a.c.ExecContext(a.ctx, "UPDATE "+q(historyTable)+" SET "+q("step")+" = "+a.placeholder(1)+" WHERE "+q("name")+" = "+a.placeholder(2), step, p.Name)
	return err
}

// applyPlan applies one plan up to the finalize step and verifies it.
func (a *applier) applyPlan(p *Plan) error {
	steps, err := a.steps(p)
	if err != nil {
		return err
	}
	if err := a.emit(ApplyEvent{Kind: "plan", Plan: p.Name, Steps: len(steps)}); err != nil {
		return err
	}
	for i, s := range steps[:finalizeStart(steps)] {
		if s.Rollback == "" {
			if err := a.emit(ApplyEvent{Kind: "irreversible", Plan: p.Name, Step: i, Steps: len(steps), Statement: s.Statement}); err != nil {
				return err
			}
		}
	}
	if err := a.record(p, stateApplying, 0); err != nil {
		return err
	}
	return a.forward(p, steps, 0)
}

// forward runs from step start up to the finalize step, verifies, and then changes the row to applied.
func (a *applier) forward(p *Plan, steps []PlanStep, start int) error {
	end := finalizeStart(steps)
	for i := start; i < end; i++ {
		statement, err := a.statementAt(p, i, steps[i].Statement, steps[i].Restore, steps[i].RestoreIf)
		if err != nil {
			return err
		}
		if err := a.runAndRecord(p, steps, i, statement, i+1); err != nil {
			return err
		}
	}
	if err := a.foreignKeyCheck(p); err != nil {
		return err
	}
	if err := a.verified(p, p.To, len(steps)); err != nil {
		return err
	}
	if err := a.record(p, stateApplied, end); err != nil {
		return err
	}
	return a.emit(ApplyEvent{Kind: "done", Plan: p.Name, Steps: len(steps)})
}

// finalizeFrom runs the finalize steps from start and changes the row to done.
func (a *applier) finalizeFrom(p *Plan, steps []PlanStep, start int) error {
	for i := start; i < len(steps); i++ {
		if err := a.run(p, steps, i, steps[i].Statement); err != nil {
			return err
		}
		if err := a.setStep(p, i+1); err != nil {
			return err
		}
	}
	if err := a.record(p, stateDone, len(steps)); err != nil {
		return err
	}
	return a.emit(ApplyEvent{Kind: "done", Plan: p.Name, Steps: len(steps)})
}

// run executes the statement of step i with an event. It checks the server session before the statement
// is run.
func (a *applier) run(p *Plan, steps []PlanStep, i int, statement string) error {
	if err := a.emit(ApplyEvent{Kind: "statement", Plan: p.Name, Step: i, Steps: len(steps), Statement: statement}); err != nil {
		return err
	}
	if err := a.checkSession(p, i); err != nil {
		return err
	}
	if _, err := a.c.ExecContext(a.ctx, statement); err != nil {
		return &ApplyError{Code: "failed", Plan: p.Name, Step: i, Message: statement, Err: err}
	}
	return a.emit(ApplyEvent{Kind: "applied", Plan: p.Name, Step: i, Steps: len(steps), Statement: statement})
}

// foreignKeyCheck checks in SQLite that no row violates a foreign key.
func (a *applier) foreignKeyCheck(p *Plan) error {
	if a.r.d != DialectSQLite {
		return nil
	}
	var broken int
	if err := a.queryRow("SELECT COUNT(*) FROM pragma_foreign_key_check", &broken); err != nil {
		return err
	}
	if broken > 0 {
		return &ApplyError{Code: "verify", Plan: p.Name, Message: fmt.Sprintf("%d rows break a foreign key", broken)}
	}
	return nil
}

// nullChecks finds the NULL rows of the columns that the rollback of the applied plan returns to non-null, and
// fills them with the default, or stops with a nulls error if there is no default (docs/spec/plans.md "Steps").
func (a *applier) nullChecks(p *Plan, steps []PlanStep) error {
	q := a.r.q
	for i, s := range steps {
		for _, c := range s.NullChecks {
			var n int64
			if err := a.queryRow("SELECT COUNT(*) FROM "+q(c.Table)+" WHERE "+q(c.Column)+" IS NULL", &n); err != nil {
				return err
			}
			if n == 0 {
				continue
			}
			if !c.HasDefault {
				return &ApplyError{Code: "nulls", Plan: p.Name, Step: i, Message: fmt.Sprintf("column %s.%s has %d NULL rows and no default to restore NOT NULL", c.Table, c.Column, n)}
			}
			if _, err := a.c.ExecContext(a.ctx, "UPDATE "+q(c.Table)+" SET "+q(c.Column)+" = "+c.Default+" WHERE "+q(c.Column)+" IS NULL"); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *applier) emit(e ApplyEvent) error {
	if a.events == nil {
		return nil
	}
	return a.events(e)
}

func (a *applier) placeholder(n int) string {
	if a.r.d == DialectPostgres {
		return fmt.Sprintf("$%d", n)
	}
	return "?"
}

func (a *applier) placeholders(n int) string {
	s := ""
	for i := 1; i <= n; i++ {
		if i > 1 {
			s += ", "
		}
		s += a.placeholder(i)
	}
	return s
}

// effectQueries are the queries that read each effect kind per dialect. Their arguments are the Table and Name
// of the Effect, and each query returns a count.
var effectQueries = map[Dialect]map[string]string{
	DialectMySQL: {
		"table":      "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
		"column":     "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
		"index":      "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
		"constraint": "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?",
		"trigger":    "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? AND TRIGGER_NAME = ?",
	},
	DialectPostgres: {
		"table":      "SELECT COUNT(*) FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p') AND relname = $1",
		"column":     "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped",
		"index":      "SELECT COUNT(*) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND i.relname = $2",
		"constraint": "SELECT COUNT(*) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND k.conname = $2",
		"trigger":    "SELECT COUNT(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND g.tgname = $2 AND NOT g.tgisinternal",
		"function":   "SELECT COUNT(*) FROM pg_proc WHERE pronamespace = current_schema()::regnamespace AND proname = $1",
	},
	DialectSQLite: {
		"table":    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
		"column":   "SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?",
		"index":    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?",
		"trigger":  "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name = ?",
		"sequence": "SELECT COUNT(*) FROM sqlite_sequence WHERE name = ?",
	},
}

// effect reports whether the effect is in the database now.
// runAndRecord runs the statement of step i and then records that the plan has
// reached step done.
func (a *applier) runAndRecord(p *Plan, steps []PlanStep, i int, statement string, done int) error {
	if err := a.run(p, steps, i, statement); err != nil {
		return err
	}
	return a.setStep(p, done)
}

// statementAt returns the statement of step i: restore when the restore
// statement of the step is set and its condition holds, and statement otherwise.
func (a *applier) statementAt(p *Plan, i int, statement, restore string, cond Effect) (string, error) {
	if restore == "" {
		return statement, nil
	}
	ok, err := a.effect(cond)
	if err != nil {
		return "", &ApplyError{Code: "failed", Plan: p.Name, Step: i, Err: err}
	}
	if ok {
		return restore, nil
	}
	return statement, nil
}

func (a *applier) effect(e Effect) (bool, error) {
	var query string
	var args []any
	if e.Kind == "rows" {
		query = "SELECT COUNT(*) FROM (SELECT 1 FROM " + a.r.q(e.Table) + " LIMIT 1) x"
	} else {
		var ok bool
		if query, ok = effectQueries[a.r.d][e.Kind]; !ok {
			return false, fmt.Errorf("the effect %s has no query on %s", e, a.r.d)
		}
		switch e.Kind {
		case "table", "sequence":
			args = []any{e.Table}
		case "function":
			args = []any{e.Name}
		default:
			args = []any{e.Table, e.Name}
		}
	}
	var n int64
	if err := a.queryRowArgs(query, args, &n); err != nil {
		return false, err
	}
	return (n > 0) == e.Present, nil
}
