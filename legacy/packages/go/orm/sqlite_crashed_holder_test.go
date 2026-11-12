package orm_test

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/internal/benchset"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// holderEnv names the database of the holder process of TestSQLiteCrashedHolderLeavesNoLock.
const holderEnv = "ORM_SQLITE_HOLDER_DSN"

// openHolder opens one connection to the SQLite file of dsn, which the test closes.
func openHolder(t *testing.T, dsn string) *orm.DB {
	t.Helper()
	db, err := model.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testcase.Close(t, db) })
	return db
}

// crashedExit is the exit status of the holder process of TestSQLiteCrashedHolderLeavesNoLock.
const crashedExit = 3

// TestSQLiteCrashedHolderLeavesNoLock starts a process that ends inside a write transaction, without a commit or a rollback.
// The operating system releases the lock of the file with the process, so a connection that does not wait for a lock writes at
// once, and SQLite rolls the uncommitted write back.
// Requirements: CFG-43.
func TestSQLiteCrashedHolderLeavesNoLock(t *testing.T) {
	testcase.Start(t, testcase.Process)
	if dsn := os.Getenv(holderEnv); dsn != "" {
		db := openHolder(t, dsn)
		err := db.Transaction(func() error {
			if _, err := model.Service().SetName("uncommitted").Create(); err != nil {
				return err
			}
			os.Exit(crashedExit)
			return nil
		}, orm.Retry(0))
		t.Fatalf("the holder process did not end in its transaction: %v", err)
	}
	dsn := "sqlite://" + filepath.Join(t.TempDir(), "crash.sqlite")
	setup := openHolder(t, dsn)
	if err := benchset.Install(setup); err != nil {
		t.Fatalf("install: %v", err)
	}
	testcase.Close(t, setup)
	cmd := exec.Command(os.Args[0], "-test.run=^TestSQLiteCrashedHolderLeavesNoLock$", "-test.count=1")
	cmd.Env = append(os.Environ(), holderEnv+"="+dsn)
	output, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != crashedExit {
		t.Fatalf("holder process: %v, want exit status %d\n%s", err, crashedExit, output)
	}
	db := openHolder(t, dsn+"?_pragma=busy_timeout(0)")
	if _, err := model.Service().Connect(db).SetName("after").Create(); err != nil {
		t.Fatalf("a write after the holder ended: %v", err)
	}
	n, err := model.Service().Connect(db).GetCount()
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("services: %d, want the one row written after the holder ended", n)
	}
}
