//go:build physical

package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

func TestPhysicalCounterCleanup(t *testing.T) {
	testcase.Group(t)
	if err := os.Mkdir(lockDir, 0o755); err != nil {
		t.Fatalf("conformance database lock: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Remove(lockDir); err != nil {
			t.Error(err)
		}
	})
	for _, test := range []struct {
		driver, env string
	}{
		{"mysql", "BENCH_MYSQL_DSN"},
		{"postgres", "BENCH_POSTGRES_DSN"},
		{"sqlite", "BENCH_SQLITE_DSN"},
	} {
		t.Run(test.driver, func(t *testing.T) {
			// database 하나에서 state digest를 앞뒤로 읽고 counter를 읽고 되돌린다.
			testcase.Start(t, 3*stateDeadline)
			raw := os.Getenv(test.env)
			if raw == "" {
				t.Fatalf("%s is required", test.env)
			}
			db, err := openStateDatabase(test.driver, raw)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := db.Close(); err != nil {
					t.Error(err)
				}
			}()
			before, err := snapshotDatabase(db, test.driver)
			if err != nil {
				t.Fatal(err)
			}
			counters, err := readCounters(db, test.driver)
			if err != nil {
				t.Fatal(err)
			}
			restored := false
			defer func() {
				if !restored {
					if err := restoreCounters(db, test.driver, counters); err != nil {
						t.Errorf("restore counters after test failure: %v", err)
					}
				}
			}()
			counterName := "task"
			if test.driver == "postgres" {
				counterName = `"public"."task_seq_seq"`
			}
			if _, ok := counters[counterName]; !ok {
				if test.driver != "sqlite" {
					t.Fatalf("task counter %s is not observable", counterName)
				}
				var definition string
				if err := db.QueryRow("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task'").Scan(&definition); err != nil {
					t.Fatalf("read task table definition: %v", err)
				}
				if !strings.Contains(strings.ToUpper(definition), "AUTOINCREMENT") {
					t.Fatal("task has no observable SQLite auto-increment counter")
				}
			}
			var id int64
			if test.driver == "postgres" {
				err = db.QueryRow("INSERT INTO task (title, state) VALUES ('counter-check', 'open') RETURNING seq").Scan(&id)
			} else {
				result, executeErr := db.Exec("INSERT INTO task (title, state) VALUES ('counter-check', 'open')")
				if executeErr != nil {
					err = executeErr
				} else {
					id, err = result.LastInsertId()
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			deleted := false
			defer func() {
				if !deleted {
					query := fmt.Sprintf("DELETE FROM task WHERE seq = %d", id)
					if _, err := db.Exec(query); err != nil {
						t.Error(err)
					}
				}
			}()
			changed, err := snapshotDatabase(db, test.driver)
			if err != nil {
				t.Fatal(err)
			}
			if before == changed {
				t.Fatal("inserted row was not observed")
			}
			advanced, err := readCounters(db, test.driver)
			if err != nil {
				t.Fatal(err)
			}
			if advanced[counterName] == counters[counterName] {
				t.Fatalf("%s task counter did not advance after insert: before=%+v after=%+v", test.driver, counters[counterName], advanced[counterName])
			}
			if _, err := db.Exec(fmt.Sprintf("DELETE FROM task WHERE seq = %d", id)); err != nil {
				t.Fatal(err)
			}
			deleted = true
			if err := restoreCounters(db, test.driver, counters); err != nil {
				t.Fatal(err)
			}
			restored = true
			after, err := snapshotDatabase(db, test.driver)
			if err != nil {
				t.Fatal(err)
			}
			if before != after {
				t.Fatal("persistent rows or counters changed after cleanup")
			}
		})
	}
}

func TestPhysicalFailedRunnerStateCheck(t *testing.T) {
	testcase.Group(t)
	if err := os.Mkdir(lockDir, 0o755); err != nil {
		t.Fatalf("conformance database lock: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Remove(lockDir); err != nil {
			t.Error(err)
		}
	})
	for _, test := range []struct {
		driver, env string
	}{
		{"mysql", "BENCH_MYSQL_DSN"},
		{"postgres", "BENCH_POSTGRES_DSN"},
		{"sqlite", "BENCH_SQLITE_DSN"},
	} {
		t.Run(test.driver, func(t *testing.T) {
			// database 하나에서 state digest를 앞뒤로 읽고 counter를 읽고 되돌린다.
			testcase.Start(t, 3*stateDeadline)
			raw := os.Getenv(test.env)
			if raw == "" {
				t.Fatalf("%s is required", test.env)
			}
			db, err := openStateDatabase(test.driver, raw)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := db.Close(); err != nil {
					t.Error(err)
				}
			}()
			before, err := snapshotDatabase(db, test.driver)
			if err != nil {
				t.Fatal(err)
			}
			counters, err := readCounters(db, test.driver)
			if err != nil {
				t.Fatal(err)
			}
			var id int64
			defer func() {
				if id != 0 {
					if _, err := db.Exec(fmt.Sprintf("DELETE FROM task WHERE seq = %d", id)); err != nil {
						t.Error(err)
					}
				}
				if err := restoreCounters(db, test.driver, counters); err != nil {
					t.Error(err)
				}
				after, err := snapshotDatabase(db, test.driver)
				if err != nil {
					t.Error(err)
				} else if before != after {
					t.Error("failed-run test did not restore all rows and counters")
				}
			}()
			runnerErr := errors.New("runner failed")
			err = runAndCheckState(db, test.driver, "rust", "first", func() error {
				if test.driver == "postgres" {
					if err := db.QueryRow("INSERT INTO task (title, state) VALUES ('failed-run-check', 'open') RETURNING seq").Scan(&id); err != nil {
						return err
					}
				} else {
					result, err := db.Exec("INSERT INTO task (title, state) VALUES ('failed-run-check', 'open')")
					if err != nil {
						return err
					}
					id, err = result.LastInsertId()
					if err != nil {
						return err
					}
				}
				return runnerErr
			})
			if !errors.Is(err, runnerErr) || !strings.Contains(err.Error(), "changed "+test.driver+" database state") {
				t.Fatalf("runner failure and remaining row must both be reported: %v", err)
			}
		})
	}
}
