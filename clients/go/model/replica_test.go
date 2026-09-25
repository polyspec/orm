package model_test

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

// replicaTargets returns the primary and replica DSN of MySQL and
// PostgreSQL; the test fails when one is unset.
func replicaTargets(t *testing.T) map[string][2]string {
	t.Helper()
	out := map[string][2]string{}
	for driver, env := range map[string]string{"mysql": "MYSQL", "postgres": "POSTGRES"} {
		primary, replica := os.Getenv("ORM_TEST_"+env+"_DSN"), os.Getenv("ORM_TEST_"+env+"_REPLICA_DSN")
		if primary == "" || replica == "" {
			t.Fatalf("ORM_TEST_%s_DSN and ORM_TEST_%s_REPLICA_DSN are required; database tests never skip", env, env)
		}
		out[driver] = [2]string{primary, replica}
	}
	return out
}

// awaitReplica returns after the replica has applied every change the
// primary committed before the call. On PostgreSQL a transaction with
// synchronous_commit=remote_apply that writes WAL, here a transactional
// logical message, commits after the standby has applied it; a transaction
// that writes no WAL besides its commit record does not wait. On MySQL
// SOURCE_POS_WAIT on the replica waits for the binary log position of the
// primary.
func awaitReplica(t *testing.T, driver, primary, replica string) {
	t.Helper()
	source := openNative(t, driver, primary)
	defer source.Close()
	if driver == "postgres" {
		tx, err := source.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec("SET LOCAL synchronous_commit = remote_apply"); err != nil {
			t.Fatal(err)
		}
		var mode, lsn string
		if err := tx.QueryRow("SELECT current_setting('synchronous_commit'), pg_logical_emit_message(true, 'orm-test-barrier', '')::text").Scan(&mode, &lsn); err != nil {
			t.Fatal(err)
		}
		if mode != "remote_apply" {
			t.Fatalf("synchronous_commit of the barrier transaction is %s", mode)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		return
	}
	var file string
	var position int64
	var ignored [3]any
	if err := source.QueryRow("SHOW BINARY LOG STATUS").Scan(&file, &position, &ignored[0], &ignored[1], &ignored[2]); err != nil {
		t.Fatal(err)
	}
	target := openNative(t, driver, replica)
	defer target.Close()
	var waited *int64
	if err := target.QueryRow("SELECT SOURCE_POS_WAIT(?, ?, 10)", file, position).Scan(&waited); err != nil {
		t.Fatal(err)
	}
	if waited == nil || *waited < 0 {
		t.Fatalf("the replica did not reach %s:%d", file, position)
	}
}

// TestPrimaryAndReplica opens a connection to the primary and one to its
// replica side by side. A model uses the connection it is connected to and
// no other, and a model without a connection inside a transaction uses the
// transaction.
func TestPrimaryAndReplica(t *testing.T) {
	manifest, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatal(err)
	}
	for driver, dsns := range replicaTargets(t) {
		t.Run(driver, func(t *testing.T) {
			primary, replica := dsns[0], dsns[1]
			master, err := model.Connect(primary, schemaPath, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer master.Close()
			dropTables(t, driver, primary)
			if err := master.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			name := fmt.Sprintf("replica-%d", time.Now().UnixNano())
			must(model.User().Connect(master).SetName(name).Create())
			awaitReplica(t, driver, primary, replica)
			slave1, err := model.Connect(replica, schemaPath, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer slave1.Close()

			if n := must(model.User().Connect(slave1).Name(name).GetCount()); n != 1 {
				t.Fatalf("the replica reads %d rows written through the primary", n)
			}
			if _, err := model.User().Connect(slave1).SetName(name + "-replica").Create(); err == nil {
				t.Fatal("a write through the replica connection succeeded")
			}
			if n := must(model.User().Connect(master).Name(name + "-replica").GetCount()); n != 0 {
				t.Fatalf("a write through the replica connection reached the primary: %d rows", n)
			}

			// A row read through the replica is written through the primary.
			row := must(model.User().Connect(slave1).Name(name).Get())
			must(row.Connect(master).SetName(name + "-renamed").Update())

			err = master.Transaction(func() error {
				must(model.User().SetName(name + "-tx").Create())
				if n := must(model.User().Connect(master).Name(name + "-tx").GetCount()); n != 1 {
					return fmt.Errorf("the primary connection inside its transaction reads %d rows", n)
				}
				if n := must(model.User().Connect(slave1).Name(name + "-tx").GetCount()); n != 0 {
					return fmt.Errorf("the replica connection reads %d uncommitted rows", n)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			awaitReplica(t, driver, primary, replica)
			if n := must(model.User().Connect(slave1).Name([]string{name + "-renamed", name + "-tx"}).GetCount()); n != 2 {
				t.Fatalf("the replica reads %d of the 2 committed rows", n)
			}
		})
	}
}
