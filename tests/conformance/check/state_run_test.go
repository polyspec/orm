package main

import (
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestFailedRunStillChecksRemainingDatabaseState(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "bench.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE author (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	err = runAndCheckState(db, "sqlite", "rust", "first", func() error {
		if _, err := db.Exec("INSERT INTO author(name) VALUES ('leftover')"); err != nil {
			return err
		}
		return errors.New("runner failed")
	})
	if err == nil || !strings.Contains(err.Error(), "runner failed") || !strings.Contains(err.Error(), "changed sqlite database state") {
		t.Fatalf("runner and state failures must both be reported, got %v", err)
	}
}

func TestFailedRunReportsOriginalErrorAfterRollback(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "bench.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE author (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	runnerErr := errors.New("runner failed")
	err = runAndCheckState(db, "sqlite", "rust", "first", func() error {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO author(name) VALUES ('rolled back')"); err != nil {
			return errors.Join(err, tx.Rollback())
		}
		return errors.Join(runnerErr, tx.Rollback())
	})
	if !errors.Is(err, runnerErr) || strings.Contains(err.Error(), "changed sqlite database state") {
		t.Fatalf("rolled-back failure must retain only the runner error, got %v", err)
	}
}
