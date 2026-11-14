package orm_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// The PostgreSQL events that order a step of a test after a lock wait or after the start of a client statement (T475). A
// test that read the lock tables on an interval, or waited on a timer, would depend on the load of the machine.

// reportLockWaits opens a PostgreSQL session on dsn that reports its lock waits: with deadlock_timeout 1 ms, log_lock_waits
// on and client_min_messages log, the server sends the session the LOG message "process <pid> still waiting for <lock> ..."
// once its statement has waited 1 ms for a lock, while the statement still waits. The channel receives a value for each
// such message that nobody has taken yet. The session is closed when the test ends.
func reportLockWaits(t *testing.T, dsn string) (*pgx.Conn, <-chan struct{}) {
	t.Helper()
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	waits := make(chan struct{}, 1)
	config.OnNotice = func(_ *pgconn.PgConn, notice *pgconn.Notice) {
		if !strings.Contains(notice.Message, "still waiting for") {
			return
		}
		select {
		case waits <- struct{}{}:
		default:
		}
	}
	conn, err := pgx.ConnectConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := conn.Close(context.Background()); err != nil {
			t.Errorf("close the session that reports its lock waits: %v", err)
		}
	})
	for _, set := range []string{"SET deadlock_timeout = '1ms'", "SET log_lock_waits = on", "SET client_min_messages = log"} {
		if _, err := conn.Exec(context.Background(), set); err != nil {
			t.Fatal(err)
		}
	}
	return conn, waits
}

// startEvent reports the start of an UPDATE of a table on PostgreSQL (statementStarts).
type startEvent struct {
	owner, waiter *pgx.Conn
	waits         <-chan struct{}
	name, table   string
}

var startEvents atomic.Int64

// statementStarts reports the start of an UPDATE of table on PostgreSQL. A client statement runs on a session of the
// client, which receives no message that the test reads, so a statement trigger of table cancels a session of the test that
// waits for an advisory lock that another session of the test holds: the error of that session (57014) reports that the
// statement has started on the server, before it takes a row lock. The trigger is installed before any session holds rows
// of table, because CREATE TRIGGER waits for them; it cancels nothing until arm names the waiting session, so an earlier
// UPDATE, such as the one of a holder, does not count. close removes the trigger, after the holder has released the rows.
func statementStarts(t *testing.T, dsn, table string) *startEvent {
	t.Helper()
	ctx := context.Background()
	owner, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	waiter, waits := reportLockWaits(t, dsn)
	s := &startEvent{owner: owner, waiter: waiter, waits: waits, name: fmt.Sprintf("orm_test_started_%d", startEvents.Add(1)), table: table}
	for _, statement := range []string{
		`CREATE TABLE "` + s.name + `" (pid integer NOT NULL)`,
		`CREATE FUNCTION "` + s.name + `"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_cancel_backend(pid) FROM "` + s.name + `"; RETURN NULL; END $$`,
		`CREATE TRIGGER "` + s.name + `" BEFORE UPDATE ON "` + table + `" FOR EACH STATEMENT EXECUTE FUNCTION "` + s.name + `"()`,
	} {
		if _, err := owner.Exec(ctx, statement); err != nil {
			t.Fatal(errors.Join(err, owner.Close(ctx)))
		}
	}
	return s
}

// arm returns when the waiting session waits for the advisory lock. The channel receives nil when an UPDATE of the table
// has started, and an error when the waiting session ended otherwise.
func (s *startEvent) arm(t *testing.T) <-chan error {
	t.Helper()
	ctx := context.Background()
	if _, err := s.owner.Exec(ctx, "SELECT pg_advisory_lock(hashtext($1))", s.name); err != nil {
		t.Fatal(err)
	}
	var pid int32
	if err := s.waiter.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	started := make(chan error, 1)
	go func() {
		_, err := s.waiter.Exec(ctx, "SELECT pg_advisory_lock(hashtext($1))", s.name)
		var pgErr *pgconn.PgError
		switch {
		case err == nil:
			started <- fmt.Errorf("%s: the waiting session took the advisory lock, so no statement cancelled it", s.name)
		case errors.As(err, &pgErr) && pgErr.Code == "57014":
			started <- nil
		default:
			started <- err
		}
	}()
	select {
	case <-s.waits:
	case err := <-started:
		t.Fatalf("%s: the waiting session ended before it waited: %v", s.name, err)
	}
	if _, err := s.owner.Exec(ctx, `INSERT INTO "`+s.name+`" (pid) VALUES ($1)`, pid); err != nil {
		t.Fatal(err)
	}
	return started
}

// close removes the trigger, its function and its table, and closes the owner session.
func (s *startEvent) close(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	for _, statement := range []string{
		`DROP TRIGGER "` + s.name + `" ON "` + s.table + `"`,
		`DROP FUNCTION "` + s.name + `"()`,
		`DROP TABLE "` + s.name + `"`,
	} {
		if _, err := s.owner.Exec(ctx, statement); err != nil {
			t.Errorf("%s: %v", statement, err)
		}
	}
	if err := s.owner.Close(ctx); err != nil {
		t.Errorf("close the owner of %s: %v", s.name, err)
	}
}

// lockProbe is a session of the test whose lock waits the server ends after one second, by its own setting:
// lock_wait_timeout and innodb_lock_wait_timeout on MySQL and MariaDB, lock_timeout on PostgreSQL. A statement of a client
// session gives the test no event when it starts to wait for a lock, so a test that cancels such a statement runs the probe
// after it has handed the statement to the client: the error of the probe (1205, 55P03) is the response of the server that
// the lock is held and that a statement waits for it, and the second of the probe's wait, which the server bounds, lets the
// statement that started before the probe reach its own wait (T475).
type lockProbe struct {
	conn *sql.Conn
}

// openLockProbe opens the probe on dsn; it is closed when the test ends.
func openLockProbe(t *testing.T, driver, dsn string) *lockProbe {
	t.Helper()
	raw := openNative(t, driver, dsn)
	conn, err := raw.Conn(context.Background())
	if err != nil {
		t.Fatal(errors.Join(err, raw.Close()))
	}
	t.Cleanup(func() {
		if err := errors.Join(conn.Close(), raw.Close()); err != nil {
			t.Errorf("close the lock probe: %v", err)
		}
	})
	settings := []string{"SET lock_timeout = '1s'"}
	if mysqlFamily(driver) {
		settings = []string{"SET SESSION lock_wait_timeout = 1", "SET SESSION innodb_lock_wait_timeout = 1"}
	}
	for _, setting := range settings {
		if _, err := conn.ExecContext(context.Background(), setting); err != nil {
			t.Fatal(err)
		}
	}
	return &lockProbe{conn: conn}
}

// waits runs statement, which needs a lock that another session holds, and returns nil when the server ends its wait with
// the lock wait timeout of the probe's setting: 1205 on MySQL and MariaDB, 55P03 on PostgreSQL. It may run on another
// goroutine than the test.
func (p *lockProbe) waits(statement string) error {
	_, err := p.conn.ExecContext(context.Background(), statement)
	var mysqlErr *mysql.MySQLError
	var pgErr *pgconn.PgError
	switch {
	case err == nil:
		return fmt.Errorf("%s took its lock, so no session held it", statement)
	case errors.As(err, &mysqlErr) && mysqlErr.Number == 1205:
		return nil
	case errors.As(err, &pgErr) && pgErr.Code == "55P03":
		return nil
	}
	return fmt.Errorf("%s: %w", statement, err)
}
