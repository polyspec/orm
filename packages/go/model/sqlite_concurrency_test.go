package model_test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"github.com/polyspec/orm/packages/go/internal/benchset"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// writerEnv names the database of a writer process started by
// TestSQLiteWritersInSeveralProcesses; the process named by writerNameEnv
// runs the writers of one process against it.
const (
	writerEnv     = "ORM_SQLITE_WRITER_DSN"
	writerNameEnv = "ORM_SQLITE_WRITER_NAME"
)

// openSQLite opens count connections to one SQLite file; the first installs
// the schema.
func openSQLite(t *testing.T, dsn string, count int, install bool) []*orm.DB {
	t.Helper()
	out := make([]*orm.DB, count)
	for i := range out {
		db, err := model.Connect(dsn, orm.Config{})
		if err != nil {
			t.Fatalf("connection %d: %v", i, err)
		}
		t.Cleanup(func() { testcase.Close(t, db) })
		out[i] = db
	}
	if install {
		if err := benchset.Install(out[0]); err != nil {
			t.Fatalf("install: %v", err)
		}
	}
	return out
}

// writeServices runs n transactions that read the service count and then
// insert one service, without transaction retries.
func writeServices(db *orm.DB, name string, n int) error {
	for i := range n {
		err := db.Transaction(func() error {
			if _, err := model.Service().GetCount(); err != nil {
				return err
			}
			_, err := model.Service().SetName(name + "-" + strconv.Itoa(i)).Create()
			return err
		}, orm.Retry(0))
		if err != nil {
			return fmt.Errorf("%s write %d: %w", name, i, err)
		}
	}
	return nil
}

// runWriters runs one writer per connection at the same time and returns
// the errors.
func runWriters(dbs []*orm.DB, prefix string, n int) []error {
	var wg sync.WaitGroup
	errs := make([]error, len(dbs))
	for i, db := range dbs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = writeServices(db, prefix+strconv.Itoa(i), n)
		}()
	}
	wg.Wait()
	return errs
}

func serviceCount(t *testing.T, db *orm.DB) int64 {
	t.Helper()
	n, err := model.Service().Connect(db).GetCount()
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// TestSQLiteWritersInSeveralProcesses (requirement CFG-42) runs 3 processes with 4 connections
// each; every connection commits 20 read-then-write transactions on one file.
func TestSQLiteWritersInSeveralProcesses(t *testing.T) {
	testcase.Start(t, testcase.Process)
	if dsn := os.Getenv(writerEnv); dsn != "" {
		for _, err := range runWriters(openSQLite(t, dsn, 4, false), os.Getenv(writerNameEnv)+"-c", 20) {
			if err != nil {
				t.Error(err)
			}
		}
		return
	}
	dsn := "sqlite://" + filepath.Join(t.TempDir(), "processes.sqlite")
	dbs := openSQLite(t, dsn, 1, true)
	var wg sync.WaitGroup
	outputs := make([][]byte, 3)
	errs := make([]error, 3)
	for i := range 3 {
		cmd := exec.Command(os.Args[0], "-test.run=^TestSQLiteWritersInSeveralProcesses$", "-test.count=1", "-test.timeout=2m")
		cmd.Env = append(os.Environ(), writerEnv+"="+dsn, writerNameEnv+"=p"+strconv.Itoa(i))
		wg.Add(1)
		go func() {
			defer wg.Done()
			outputs[i], errs[i] = cmd.CombinedOutput()
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("process %d: %v\n%s", i, err, outputs[i])
		}
	}
	if n := serviceCount(t, dbs[0]); n != 240 {
		t.Fatalf("services: %d, want 240", n)
	}
}
