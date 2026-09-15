package orm

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestParseDSN(t *testing.T) {
	tests := []struct {
		name, input, driver, native string
	}{
		{"mysql tcp", "mysql://app:secret@127.0.0.1:3306/app?parseTime=true&clientFoundRows=true", "mysql", "app:secret@tcp(127.0.0.1:3306)/app?clientFoundRows=true&parseTime=true"},
		{"mysql socket", "mysql://root@localhost/app?socket=/tmp/mysql.sock&parseTime=true&clientFoundRows=true", "mysql", "root@unix(/tmp/mysql.sock)/app?clientFoundRows=true&parseTime=true"},
		{"postgres", "postgres://app:secret@127.0.0.1:5432/app?sslmode=disable", "postgres", "postgres://app:secret@127.0.0.1:5432/app?sslmode=disable"},
		{"sqlite", "sqlite:///tmp/app.sqlite?_pragma=busy_timeout(5000)", "sqlite", "file:/tmp/app.sqlite?_pragma=busy_timeout%285000%29&_txlock=deferred"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			driver, native, err := parseDSN(tt.input)
			if err != nil || driver != tt.driver || native != tt.native {
				t.Fatalf("parseDSN() = driver=%q native=%q err=%v, want driver=%q native=%q", driver, native, err, tt.driver, tt.native)
			}
		})
	}
}

func TestParseDSNRejectsSQLiteImmediateTransactions(t *testing.T) {
	if _, _, err := parseDSN("sqlite:///tmp/app.sqlite?_txlock=immediate"); err == nil {
		t.Fatal("parseDSN accepted immediate SQLite transactions")
	}
}

func TestSQLiteORMRowLockSerializesAndNoWaits(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock.sqlite")
	_, native, err := parseDSN("sqlite://" + path + "?_busy_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	first, err := sql.Open("sqlite", native)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := sql.Open("sqlite", native)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if _, err := first.ExecContext(context.Background(), "CREATE TABLE lock_probe (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	tx, err := first.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	firstDB := &DB{SQL: first, driver: "sqlite", stmts: map[string]*sql.Stmt{}}
	secondDB := &DB{SQL: second, driver: "sqlite", stmts: map[string]*sql.Stmt{}}
	firstORM, err := Begin(context.Background(), firstDB, TransactionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer firstORM.Rollback(context.Background())
	if err := acquireSQLiteRowLock(context.Background(), firstORM, "update"); err != nil {
		t.Fatal("first SQLite lock", err)
	}
	secondORM, err := Begin(context.Background(), secondDB, TransactionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer secondORM.Rollback(context.Background())
	started := time.Now()
	if err := acquireSQLiteRowLock(ctx, secondORM, "update_nowait"); err == nil {
		t.Fatal("SQLite no-wait lock succeeded while another transaction held the ORM lock")
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("SQLite no-wait lock waited %s", elapsed)
	}
}

func TestParseDSNRejectsUnsupportedOrUnsafeDSN(t *testing.T) {
	for _, input := range []string{
		"mysql://root@localhost/app?parseTime=true",
		"mysql://root@localhost/app",
		"mysql://root@localhost",
		"postgres://root@localhost",
		"sqlite://relative.sqlite",
		"oracle://root@localhost/app",
	} {
		t.Run(input, func(t *testing.T) {
			if _, _, err := parseDSN(input); err == nil {
				t.Fatal("parseDSN accepted an invalid DSN")
			}
		})
	}
}
