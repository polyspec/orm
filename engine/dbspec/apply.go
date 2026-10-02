package dbspec

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// Execer는 명령이 statement를 실행하고 catalog를 읽는 connection 하나다.
// *sql.Conn이 이를 만족하며, 명령은 lock과 session 설정을 그 connection에서만 쓴다.
type Execer interface {
	Querier
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// ApplyEvent는 apply, recover, rollback, finalize가 알리는 일이다(docs/plans.md
// "Apply"). Kind는 plan, rollback, finalize, irreversible, statement, applied,
// verified, done 중 하나다.
type ApplyEvent struct {
	Kind      string
	Plan      string
	Step      int
	Steps     int
	Statement string
}

// ApplyError는 명령의 실패다. Code는 locked, interrupted, drift, chain, failed,
// verify, irreversible, nulls 중 하나다.
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

// historyTable은 적용한 plan을 기록하는 table이다. dbspec 이름에는 $가 없으므로
// 사용자 table과 겹치지 않고, introspection은 dbspec$로 시작하는 table을 빼고 읽는다.
const historyTable = "dbspec$plans"

// mysqlLockName은 현재 database 하나의 lock 이름이다. MySQL lock 이름은
// 64자까지이므로 database 이름 대신 그 SHA-256 hex 앞 51자를 붙여 64자로 만든다.
const mysqlLockName = "CONCAT('" + historyTable + "$', LEFT(SHA2(DATABASE(), 256), 51))"

// postgresLockKey는 현재 database의 현재 schema 하나의 advisory lock key다.
const postgresLockKey = "hashtext('" + historyTable + "'), hashtext(current_schema())"

// lockWait은 statement가 다른 session의 lock을 기다리는 최대 시간이다(docs/plans.md
// "Apply"의 lock 대기).
const (
	lockWaitSeconds = 5
	lockWaitMillis  = lockWaitSeconds * 1000
)

// history row의 state.
const (
	stateApplying    = "applying"
	stateApplied     = "applied"
	stateFinalizing  = "finalizing"
	stateDone        = "done"
	stateRollingBack = "rolling_back"
)

// applier는 명령 한 번의 상태다.
type applier struct {
	ctx     context.Context
	c       Execer
	r       renderer
	now     func() time.Time
	events  func(ApplyEvent) error
	chain   []*Plan
	history map[string]historyRow
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

// Apply는 chain에서 database가 아직 적용하지 않은 plan을 차례로 finalize step 앞까지
// 적용한다. 이미 끝까지 적용한 database에서는 아무것도 바꾸지 않는다.
func Apply(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error) error {
	a, err := newApplier(ctx, c, dialect, plans, now, events)
	if err != nil {
		return err
	}
	return a.session(func() error {
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

// Recover는 중단된 plan을 catalog의 효과로 판단해 앞으로 이어 간다. 중단된 plan이
// 없으면 아무것도 바꾸지 않는다.
func Recover(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error) error {
	a, err := newApplier(ctx, c, dialect, plans, now, events)
	if err != nil {
		return err
	}
	return a.session(func() error {
		position, err := a.position()
		if err != nil || position == 0 {
			return err
		}
		p := a.chain[position-1]
		row := a.history[p.Name]
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

// Rollback은 history의 마지막 plan을 rollback statement로 step 0까지 되돌리고 그
// row를 지운다. row가 없으면 아무것도 바꾸지 않는다.
func Rollback(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error) error {
	a, err := newApplier(ctx, c, dialect, plans, now, events)
	if err != nil {
		return err
	}
	return a.session(func() error {
		position, err := a.position()
		if err != nil || position == 0 {
			return err
		}
		p := a.chain[position-1]
		row := a.history[p.Name]
		steps, err := a.steps(p)
		if err != nil {
			return err
		}
		k := row.step
		applied := row.state == stateApplied || row.state == stateDone
		if applied {
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
			statement := steps[i].Rollback
			if steps[i].RollbackRestore != "" {
				restore, err := a.effect(steps[i].RestoreIf)
				if err != nil {
					return &ApplyError{Code: "failed", Plan: p.Name, Step: i, Err: err}
				}
				if restore {
					statement = steps[i].RollbackRestore
				}
			}
			if err := a.run(p, steps, i, statement); err != nil {
				return err
			}
			if err := a.setStep(p, i); err != nil {
				return err
			}
		}
		if err := a.foreignKeyCheck(p); err != nil {
			return err
		}
		if err := a.verify(p.From); err != nil {
			return &ApplyError{Code: "verify", Plan: p.Name, Err: err}
		}
		if err := a.emit(ApplyEvent{Kind: "verified", Plan: p.Name, Steps: len(steps)}); err != nil {
			return err
		}
		q := a.r.q
		if _, err := a.c.ExecContext(a.ctx, "DELETE FROM "+q(historyTable)+" WHERE "+q("name")+" = "+a.placeholder(1), p.Name); err != nil {
			return err
		}
		return a.emit(ApplyEvent{Kind: "done", Plan: p.Name, Steps: len(steps)})
	})
}

// Finalize는 applied인 모든 plan의 finalize step을 chain 순서로 실행해 숨긴 table과
// column을 지운다.
func Finalize(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error) error {
	a, err := newApplier(ctx, c, dialect, plans, now, events)
	if err != nil {
		return err
	}
	return a.session(func() error {
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

// finalizeStart는 첫 finalize step의 index다.
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

// session은 dialect의 lock을 잡고 session 설정을 바꾼 뒤 f를 실행하고, 끝에 설정을
// 되돌리고 lock을 놓는다.
func (a *applier) session(f func() error) error {
	switch a.r.d {
	case DialectMySQL:
		var got sql.NullInt64
		if err := a.queryRow("SELECT GET_LOCK("+mysqlLockName+", 0)", &got); err != nil {
			return err
		}
		// GET_LOCK의 NULL은 lock을 기다리던 중의 error다.
		switch {
		case !got.Valid:
			return fmt.Errorf("GET_LOCK returned NULL; want 1 or 0")
		case got.Int64 != 0 && got.Int64 != 1:
			return fmt.Errorf("GET_LOCK returned %d; want 1 or 0", got.Int64)
		case got.Int64 == 0:
			return &ApplyError{Code: "locked", Message: "another session holds the " + historyTable + " lock of this database"}
		}
		var lockWait, rowWait int64
		err := a.queryRow("SELECT @@SESSION.lock_wait_timeout, @@SESSION.innodb_lock_wait_timeout", &lockWait, &rowWait)
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
		// current_schema()가 NULL이면 결과도 NULL이며, bool로 읽지 못해 error다.
		var got bool
		if err := a.queryRow("SELECT pg_try_advisory_lock("+postgresLockKey+")", &got); err != nil {
			return err
		}
		if !got {
			return &ApplyError{Code: "locked", Message: "another session holds the " + historyTable + " advisory lock of this schema"}
		}
		var previous, set string
		err := a.queryRow("SELECT current_setting('lock_timeout')", &previous)
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

// sqliteSession은 SQLite의 exclusive locking mode로 file을 잠그고, foreign key를 끄고,
// 이름 바꾸기가 다른 table의 foreign key를 데려가게 한다.
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
			// locking mode를 되돌린 뒤 한 번 읽어야 exclusive lock이 풀린다.
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

// joinCleanup은 실패와 그 뒤 정리 단계의 error를 함께 돌려준다. nil이 아닌 error가
// 하나뿐이면 감싸지 않고 그 error를 그대로 돌려주고, 여럿이면 errors.Join으로 순서대로 담는다.
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

// appliedAt은 history의 applied_at text다: tool clock의 UTC 시각을 소수 여섯
// 자리로 버림한 YYYY-MM-DDTHH:MM:SS.ffffffZ (docs/plans.md "Apply").
func appliedAt(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000000Z")
}

// createHistory는 history table을 없을 때 만든다.
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

// position은 history를 읽어 기록된 plan 수를 돌려준다. 기록은 chain의 앞부분이어야
// 하고, 마지막 앞의 row는 applied나 done이어야 한다.
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

// settled는 중단된 plan이 없고 catalog가 기록한 schema와 같을 때 기록된 plan 수를
// 돌려준다.
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

// verify는 database의 introspection이 want schemaHash(빈 문자열이면 빈
// database)이고 미지원 객체가 없는지 확인한다.
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

// steps는 chain에서 plan의 앞 plan target을 source로 step을 쓴다.
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

// resolve는 중단된 row의 step을 catalog의 효과로 정한다. forward이면 앞으로, 아니면
// 뒤로 이어 갈 위치다(docs/plans.md "Apply"의 recover).
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
	// 앞으로 갈 때 repeat step은 다시 실행하고, 뒤로 갈 때는 그 rollback을 다시 실행한다.
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

// record는 plan의 row를 state와 step으로 쓴다. row가 없으면 만든다.
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

// applyPlan은 plan 하나를 finalize step 앞까지 적용하고 검증한다.
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

// forward는 step start부터 finalize step 앞까지 실행하고 검증한 뒤 row를 applied로 바꾼다.
func (a *applier) forward(p *Plan, steps []PlanStep, start int) error {
	end := finalizeStart(steps)
	for i := start; i < end; i++ {
		statement := steps[i].Statement
		if steps[i].Restore != "" {
			restore, err := a.effect(steps[i].RestoreIf)
			if err != nil {
				return &ApplyError{Code: "failed", Plan: p.Name, Step: i, Err: err}
			}
			if restore {
				statement = steps[i].Restore
			}
		}
		if err := a.run(p, steps, i, statement); err != nil {
			return err
		}
		if err := a.setStep(p, i+1); err != nil {
			return err
		}
	}
	if err := a.foreignKeyCheck(p); err != nil {
		return err
	}
	if err := a.verify(p.To); err != nil {
		return &ApplyError{Code: "verify", Plan: p.Name, Err: err}
	}
	if err := a.emit(ApplyEvent{Kind: "verified", Plan: p.Name, Steps: len(steps)}); err != nil {
		return err
	}
	if err := a.record(p, stateApplied, end); err != nil {
		return err
	}
	return a.emit(ApplyEvent{Kind: "done", Plan: p.Name, Steps: len(steps)})
}

// finalizeFrom은 finalize step을 start부터 실행하고 row를 done으로 바꾼다.
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

// run은 step i의 statement 하나를 event와 함께 실행한다.
func (a *applier) run(p *Plan, steps []PlanStep, i int, statement string) error {
	if err := a.emit(ApplyEvent{Kind: "statement", Plan: p.Name, Step: i, Steps: len(steps), Statement: statement}); err != nil {
		return err
	}
	if _, err := a.c.ExecContext(a.ctx, statement); err != nil {
		return &ApplyError{Code: "failed", Plan: p.Name, Step: i, Message: statement, Err: err}
	}
	return a.emit(ApplyEvent{Kind: "applied", Plan: p.Name, Step: i, Steps: len(steps), Statement: statement})
}

// foreignKeyCheck는 SQLite에서 foreign key를 어기는 row가 없는지 확인한다.
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

// nullChecks는 적용한 plan의 rollback이 non-null로 되돌릴 column의 NULL row를
// default로 채우거나, default가 없으면 nulls error로 멈춘다(docs/plans.md "Steps").
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

// effectQueries는 dialect마다 효과 종류를 읽는 query다. 인자는 Effect의 Table과 Name
// 중 query가 쓰는 것이며, query는 개수를 돌려준다.
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

// effect는 효과가 지금 database에 있는지 알려 준다.
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
