package main

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/internal/testcase"
)

func TestSnapshotIncludesRowsAndSequenceState(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, err := sql.Open("sqlite", t.TempDir()+"/state.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	before, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO items (value) VALUES ('first')"); err != nil {
		t.Fatal(err)
	}
	withRow, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if before == withRow {
		t.Fatal("inserted row did not change snapshot")
	}
	if _, err := db.Exec("DELETE FROM items"); err != nil {
		t.Fatal(err)
	}
	afterDelete, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if before == afterDelete {
		t.Fatal("advanced sequence was hidden after row deletion")
	}
}

func TestSQLiteStateWithoutAutoIncrement(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, err := sql.Open("sqlite", t.TempDir()+"/plain.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE state (value INTEGER NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	var sequenceTables int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").Scan(&sequenceTables); err != nil {
		t.Fatal(err)
	}
	if sequenceTables != 0 {
		t.Fatal("fixture unexpectedly created sqlite_sequence")
	}
	counters, err := readCounters(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if len(counters) != 0 {
		t.Fatalf("ordinary SQLite table has counters: %v", counters)
	}
	before, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO state (value) VALUES (7)"); err != nil {
		t.Fatal(err)
	}
	after, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("row change disappeared when sqlite_sequence was absent")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := readCounters(db, "sqlite"); err == nil {
		t.Fatal("an unrelated counter query error was accepted as an absent sequence")
	}
}

func TestRestoreDeclaredSequenceAfterWrite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, err := sql.Open("sqlite", t.TempDir()+"/restore.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE author (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)"); err != nil {
		t.Fatal(err)
	}
	before, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	counters, err := readCounters(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO author (name) VALUES ('temp')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DELETE FROM author"); err != nil {
		t.Fatal(err)
	}
	if err := restoreCounters(db, "sqlite", counters); err != nil {
		t.Fatal(err)
	}
	after, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("database state changed after declared sequence cleanup")
	}
}

// TestSnapshotIgnoresTheRowLockTable는 SQLite client가 첫 transaction 전에 만드는 orm__row_lock과 그 행이 상태를
// 바꾸지 않는지 확인한다. 그 table이 생겨도 test가 database에 남긴 것은 없다.
func TestSnapshotIgnoresTheRowLockTable(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, err := sql.Open("sqlite", t.TempDir()+"/lock.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	before, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO "orm__row_lock" ("id") VALUES (1)`); err != nil {
		t.Fatal(err)
	}
	after, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("the row lock table of the client changed the snapshot")
	}
}
