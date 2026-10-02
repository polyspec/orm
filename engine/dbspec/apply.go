package dbspec

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"time"
)

// Execer는 apply가 statement를 실행하고 catalog를 읽는 connection 하나다.
// *sql.Conn이 이를 만족하며, apply는 transaction과 lock을 그 connection에서만 쓴다.
type Execer interface {
	Querier
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// ApplyEvent는 apply가 알리는 일이다(docs/plans.md "Apply"). Kind는 plan,
// statement, applied, verified, done 중 하나다.
type ApplyEvent struct {
	Kind      string
	Plan      string
	Step      int
	Steps     int
	Statement string
}

// ApplyError는 apply와 recover의 실패다. Code는 locked, interrupted, drift,
// chain, failed, verify 중 하나다.
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
	if e.Code == "failed" || e.Code == "interrupted" {
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
// 사용자 table과 겹치지 않고, introspection은 이 table을 빼고 읽는다.
const historyTable = "dbspec$plans"

// mysqlLockName은 현재 database 하나의 apply lock 이름이다. MySQL lock 이름은
// 64자까지이므로 database 이름 대신 그 SHA-256 hex 앞 51자를 붙여 64자로 만든다.
const mysqlLockName = "CONCAT('" + historyTable + "$', LEFT(SHA2(DATABASE(), 256), 51))"

// postgresLockKey는 현재 database의 현재 schema 하나의 advisory lock key다.
const postgresLockKey = "hashtext('" + historyTable + "'), hashtext(current_schema())"

// applier는 apply 한 번의 상태다.
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

// Apply는 chain에서 database가 아직 적용하지 않은 plan을 차례로 적용한다.
// 이미 끝까지 적용한 database에서는 아무것도 바꾸지 않는다.
func Apply(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error) error {
	a, err := newApplier(ctx, c, dialect, plans, now, events)
	if err != nil {
		return err
	}
	return a.locked(func() error {
		position, err := a.state()
		if err != nil {
			return err
		}
		for _, p := range a.chain[position:] {
			if err := a.applyPlan(p, 0, false); err != nil {
				return err
			}
		}
		return nil
	})
}

// Recover는 MySQL에서 중단된 plan을 catalog의 효과로 이어서 끝낸다.
// 중단된 plan이 없으면 아무것도 바꾸지 않는다.
func Recover(ctx context.Context, c Execer, dialect Dialect, plans []*Plan, now func() time.Time, events func(ApplyEvent) error) error {
	a, err := newApplier(ctx, c, dialect, plans, now, events)
	if err != nil {
		return err
	}
	return a.locked(func() error {
		if err := a.readHistory(); err != nil {
			return err
		}
		for _, p := range a.chain {
			row, ok := a.history[p.Name]
			if !ok || row.state != "running" {
				continue
			}
			if a.r.d != DialectMySQL {
				return &ApplyError{Code: "interrupted", Plan: p.Name, Step: row.step, Message: "only MySQL leaves a running plan; the row is not from apply"}
			}
			statements, err := a.statements(p)
			if err != nil {
				return err
			}
			start := row.step
			if start < len(statements) {
				done, err := a.mysqlEffect(statements[start])
				if err != nil {
					return &ApplyError{Code: "failed", Plan: p.Name, Step: start, Err: err}
				}
				if done {
					start++
				}
			}
			return a.applyPlan(p, start, true)
		}
		return nil
	})
}

// locked는 dialect의 lock을 잡고 f를 실행한다. SQLite는 apply 전체를 한
// transaction으로 실행하며 그 transaction이 lock이다.
func (a *applier) locked(f func() error) error {
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
		err := f()
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
		err := f()
		var released bool
		unlock := a.queryRow("SELECT pg_advisory_unlock("+postgresLockKey+")", &released)
		if unlock == nil && !released {
			unlock = fmt.Errorf("the advisory lock of %s was not held at unlock", historyTable)
		}
		return joinCleanup(err, unlock)
	}
	if _, err := a.c.ExecContext(a.ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return err
	}
	if _, err := a.c.ExecContext(a.ctx, "BEGIN IMMEDIATE"); err != nil {
		_, restore := a.c.ExecContext(a.ctx, "PRAGMA foreign_keys = ON")
		return joinCleanup(&ApplyError{Code: "locked", Message: "another connection holds the SQLite write lock", Err: err}, restore)
	}
	err := f()
	end := "COMMIT"
	if err != nil {
		end = "ROLLBACK"
	}
	_, ended := a.c.ExecContext(a.ctx, end)
	_, restore := a.c.ExecContext(a.ctx, "PRAGMA foreign_keys = ON")
	return joinCleanup(err, ended, restore)
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
	rows, err := a.c.QueryContext(a.ctx, query)
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

// state는 chain에서 다음에 적용할 plan의 위치를 돌려준다. 기록이 chain과 맞지
// 않거나, 중단된 plan이 있거나, catalog가 기록한 schema와 다르면 error다.
func (a *applier) state() (int, error) {
	if err := a.readHistory(); err != nil {
		return 0, err
	}
	position := 0
	for i, p := range a.chain {
		row, ok := a.history[p.Name]
		switch {
		case !ok:
			continue
		case row.state == "running":
			return 0, &ApplyError{Code: "interrupted", Plan: p.Name, Step: row.step, Message: "run recover"}
		case row.to != p.To || row.from != hashOrEmpty(p.From):
			return 0, &ApplyError{Code: "chain", Plan: p.Name, Message: "the recorded plan has other hashes than the chain's plan"}
		case i != position:
			return 0, &ApplyError{Code: "chain", Plan: p.Name, Message: "a plan before it in the chain is not recorded"}
		}
		position = i + 1
	}
	if len(a.history) != position {
		return 0, &ApplyError{Code: "chain", Message: "the history records a plan that is not in the chain"}
	}
	want := ""
	if position > 0 {
		want = a.chain[position-1].To
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

// statements는 chain에서 plan의 앞 plan target을 source로 statement를 쓴다.
func (a *applier) statements(p *Plan) ([]string, error) {
	var source *Document
	for i, c := range a.chain {
		if c == p && i > 0 {
			source = a.chain[i-1].Schema
		}
	}
	statements, diagnostics := PlanStatements(source, p, a.r.d)
	if len(diagnostics) > 0 {
		return nil, &ApplyError{Code: "chain", Plan: p.Name, Message: diagnostics[0].Message}
	}
	return statements, nil
}

// applyPlan은 plan 하나를 start 번째 statement부터 적용하고 검증한다. resume이면
// 기록된 running row를 이어 쓴다.
func (a *applier) applyPlan(p *Plan, start int, resume bool) error {
	statements, err := a.statements(p)
	if err != nil {
		return err
	}
	if err := a.emit(ApplyEvent{Kind: "plan", Plan: p.Name, Steps: len(statements)}); err != nil {
		return err
	}
	postgres := a.r.d == DialectPostgres
	if postgres {
		if _, err := a.c.ExecContext(a.ctx, "BEGIN"); err != nil {
			return err
		}
	}
	err = a.runPlan(p, statements, start, resume)
	if postgres {
		end := "COMMIT"
		if err != nil {
			end = "ROLLBACK"
		}
		_, ended := a.c.ExecContext(a.ctx, end)
		err = joinCleanup(err, ended)
	}
	if err != nil {
		return err
	}
	return a.emit(ApplyEvent{Kind: "done", Plan: p.Name, Steps: len(statements)})
}

func (a *applier) runPlan(p *Plan, statements []string, start int, resume bool) error {
	q := a.r.q
	if !resume {
		_, err := a.c.ExecContext(a.ctx, "INSERT INTO "+q(historyTable)+" ("+q("name")+", "+q("from_hash")+", "+q("to_hash")+", "+
			q("state")+", "+q("step")+", "+q("steps")+", "+q("applied_at")+") VALUES ("+a.placeholders(7)+")",
			p.Name, hashOrEmpty(p.From), p.To, "running", 0, len(statements), appliedAt(a.now()))
		if err != nil {
			return err
		}
	}
	step := func(n int) error {
		_, err := a.c.ExecContext(a.ctx, "UPDATE "+q(historyTable)+" SET "+q("step")+" = "+a.placeholder(1)+" WHERE "+q("name")+" = "+a.placeholder(2), n, p.Name)
		return err
	}
	if resume {
		if err := step(start); err != nil {
			return err
		}
	}
	for i := start; i < len(statements); i++ {
		if err := a.emit(ApplyEvent{Kind: "statement", Plan: p.Name, Step: i, Steps: len(statements), Statement: statements[i]}); err != nil {
			return err
		}
		if _, err := a.c.ExecContext(a.ctx, statements[i]); err != nil {
			return &ApplyError{Code: "failed", Plan: p.Name, Step: i, Message: statements[i], Err: err}
		}
		if err := a.emit(ApplyEvent{Kind: "applied", Plan: p.Name, Step: i, Steps: len(statements), Statement: statements[i]}); err != nil {
			return err
		}
		if err := step(i + 1); err != nil {
			return err
		}
	}
	if a.r.d == DialectSQLite {
		var broken int
		if err := a.queryRow("SELECT COUNT(*) FROM pragma_foreign_key_check", &broken); err != nil {
			return err
		}
		if broken > 0 {
			return &ApplyError{Code: "verify", Plan: p.Name, Message: fmt.Sprintf("%d rows break a foreign key", broken)}
		}
	}
	if err := a.verify(p.To); err != nil {
		return &ApplyError{Code: "verify", Plan: p.Name, Err: err}
	}
	if err := a.emit(ApplyEvent{Kind: "verified", Plan: p.Name, Steps: len(statements)}); err != nil {
		return err
	}
	_, err := a.c.ExecContext(a.ctx, "UPDATE "+q(historyTable)+" SET "+q("state")+" = 'done' WHERE "+q("name")+" = "+a.placeholder(1), p.Name)
	return err
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

// mysqlEffects는 plan writer가 쓰는 MySQL statement 형식과 그 효과다
// (docs/plans.md "Apply", recovery). 효과가 없는 MODIFY COLUMN은 다시 실행한다.
var mysqlEffects = []struct {
	pattern *regexp.Regexp
	kind    string
	present bool
}{
	{regexp.MustCompile("^DROP TRIGGER `([^`]+)`$"), "trigger", false},
	{regexp.MustCompile("^ALTER TABLE `([^`]+)` DROP FOREIGN KEY `([^`]+)`$"), "constraint", false},
	{regexp.MustCompile("^ALTER TABLE `([^`]+)` DROP CHECK `([^`]+)`$"), "constraint", false},
	{regexp.MustCompile("^ALTER TABLE `([^`]+)` DROP INDEX `([^`]+)`$"), "index", false},
	{regexp.MustCompile("^DROP INDEX `([^`]+)` ON `([^`]+)`$"), "index_on", false},
	{regexp.MustCompile("^ALTER TABLE `[^`]+` RENAME TO `([^`]+)`$"), "table", true},
	{regexp.MustCompile("^ALTER TABLE `([^`]+)` RENAME COLUMN `[^`]+` TO `([^`]+)`$"), "column", true},
	{regexp.MustCompile("^ALTER TABLE `([^`]+)` DROP COLUMN `([^`]+)`$"), "column", false},
	{regexp.MustCompile("^DROP TABLE `([^`]+)`$"), "table", false},
	{regexp.MustCompile("^CREATE TABLE `([^`]+)` "), "table", true},
	{regexp.MustCompile("^CREATE INDEX `([^`]+)` ON `([^`]+)` "), "index_on", true},
	{regexp.MustCompile("^ALTER TABLE `([^`]+)` ADD COLUMN `([^`]+)` "), "column", true},
	{regexp.MustCompile("^ALTER TABLE `[^`]+` MODIFY COLUMN "), "repeat", false},
	{regexp.MustCompile("^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` UNIQUE "), "index", true},
	{regexp.MustCompile("^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` (CHECK|FOREIGN KEY) "), "constraint", true},
	{regexp.MustCompile("^CREATE TRIGGER `([^`]+)` "), "trigger", true},
}

// mysqlEffect는 statement의 효과가 catalog에 있는지 알려 준다.
func (a *applier) mysqlEffect(statement string) (bool, error) {
	for _, e := range mysqlEffects {
		m := e.pattern.FindStringSubmatch(statement)
		if m == nil {
			continue
		}
		var query string
		var args []any
		switch e.kind {
		case "repeat":
			return false, nil
		case "trigger":
			query, args = "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?", []any{m[1]}
		case "table":
			query, args = "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", []any{m[1]}
		case "column":
			query, args = "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", []any{m[1], m[2]}
		case "constraint":
			query, args = "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?", []any{m[1], m[2]}
		case "index":
			query, args = "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?", []any{m[1], m[2]}
		case "index_on":
			query, args = "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?", []any{m[2], m[1]}
		}
		rows, err := a.c.QueryContext(a.ctx, query, args...)
		if err != nil {
			return false, err
		}
		var n int
		if rows.Next() {
			err = rows.Scan(&n)
		} else if err = rows.Err(); err == nil {
			err = fmt.Errorf("%s returned no row", query)
		}
		err = joinCleanup(err, rows.Close())
		if err != nil {
			return false, err
		}
		return (n > 0) == e.present, nil
	}
	return false, fmt.Errorf("statement %q has no known effect", statement)
}
