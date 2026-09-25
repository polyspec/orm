package model_test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
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
		db, err := model.Connect(dsn, schemaPath, orm.Config{})
		if err != nil {
			t.Fatalf("connection %d: %v", i, err)
		}
		t.Cleanup(func() { db.Close() })
		out[i] = db
	}
	if install {
		manifest, err := os.ReadFile(schemaPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := out[0].Utils().Schema().Install(manifest); err != nil {
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

// TestSQLiteWritersOnSeveralConnections runs 8 connections that each commit
// 10 read-then-write transactions on one file with the default lock wait.
func TestSQLiteWritersOnSeveralConnections(t *testing.T) {
	dsn := "sqlite://" + filepath.Join(t.TempDir(), "writers.sqlite")
	dbs := openSQLite(t, dsn, 8, true)
	for _, err := range runWriters(dbs, "c", 10) {
		if err != nil {
			t.Error(err)
		}
	}
	if n := serviceCount(t, dbs[0]); n != 80 {
		t.Fatalf("services: %d, want 80", n)
	}
}

// TestSQLiteWritersInSeveralProcesses runs 3 processes with 4 connections
// each; every connection commits 20 read-then-write transactions on one file.
func TestSQLiteWritersInSeveralProcesses(t *testing.T) {
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

// TestSQLiteReadsDuringWrite reads from another connection, with and without
// a read-only transaction, while a write transaction holds the write lock.
func TestSQLiteReadsDuringWrite(t *testing.T) {
	dsn := "sqlite://" + filepath.Join(t.TempDir(), "reads.sqlite")
	dbs := openSQLite(t, dsn, 2, true)
	writer, reader := dbs[0], dbs[1]
	written := make(chan struct{})
	read := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- writer.Transaction(func() error {
			if _, err := model.Service().SetName("pending").Create(); err != nil {
				return err
			}
			close(written)
			<-read
			return nil
		}, orm.Retry(0))
	}()
	<-written
	if n := serviceCount(t, reader); n != 0 {
		t.Errorf("read during the write: %d services, want 0", n)
	}
	err := reader.Transaction(func() error {
		n, err := model.Service().GetCount()
		if err == nil && n != 0 {
			t.Errorf("read-only transaction during the write: %d services, want 0", n)
		}
		return err
	}, orm.ReadOnly(), orm.Retry(0))
	if err != nil {
		t.Errorf("read-only transaction during the write: %v", err)
	}
	close(read)
	if err := <-done; err != nil {
		t.Fatalf("write: %v", err)
	}
	if n := serviceCount(t, reader); n != 1 {
		t.Fatalf("read after the write: %d services, want 1", n)
	}
}

// TestSQLiteLockWaitExpires holds the write lock longer than the busy_timeout
// of another connection, whose write transaction returns CANCELED after the
// wait.
func TestSQLiteLockWaitExpires(t *testing.T) {
	path := filepath.Join(t.TempDir(), "expiry.sqlite")
	holder := openSQLite(t, "sqlite://"+path, 1, true)[0]
	waiter := openSQLite(t, "sqlite://"+path+"?_pragma=busy_timeout(200)", 1, false)[0]
	locked := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- holder.Transaction(func() error {
			if _, err := model.Service().SetName("holder").Create(); err != nil {
				return err
			}
			close(locked)
			<-release
			return nil
		}, orm.Retry(0))
	}()
	<-locked
	started := time.Now()
	err := writeServices(waiter, "waiter", 1)
	waited := time.Since(started)
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("holder: %v", err)
	}
	if orm.ErrorCode(err) != orm.CodeCanceled {
		t.Fatalf("write past the lock wait: %v, want %s", err, orm.CodeCanceled)
	}
	if waited < 200*time.Millisecond {
		t.Fatalf("write returned after %v, before the 200ms lock wait", waited)
	}
}
