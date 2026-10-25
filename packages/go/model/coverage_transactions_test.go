//go:build featurecoverage

package model_test

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// transactionTenant is the tenant_id of composite_account that these cases use.
const transactionTenant = 990003

// requireNoTransactionRows checks that there are no tenant rows, and has the rows left at case end
// removed.
func requireNoTransactionRows(t *testing.T, db *orm.DB) {
	t.Helper()
	if n := must(model.CompositeAccount().Connect(db).TenantId(transactionTenant).GetCount()); n != 0 {
		t.Fatalf("composite_account already has %d rows of tenant %d", n, transactionTenant)
	}
	t.Cleanup(func() { removeTenantAccounts(t, db, transactionTenant) })
}

// accountExists reads whether composite_account (tenant, account) exists.
func accountExists(t *testing.T, db *orm.DB, tenant, account int64) bool {
	t.Helper()
	row, err := model.CompositeAccount().Connect(db).GetByTenantIdAndAccountId(tenant, account)
	if err != nil {
		t.Fatal(err)
	}
	return row != nil
}

// TestCoverageTransactionRollback checks that a transaction whose callback returns an error
// passes that error to the caller and rolls back the callback's writes.
// Requirements: DSL-118, INT-45, PLN-13, PLN-20, PLN-44.
func TestCoverageTransactionRollback(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	requireNoTransactionRows(t, db)
	boom := errors.New("transaction_rollback")
	err := db.Transaction(func() error {
		if _, err := model.CompositeAccount().SetTenantId(transactionTenant).SetAccountId(1).SetName("rolled").Create(); err != nil {
			return err
		}
		return boom
	}, orm.Retry(0))
	if !errors.Is(err, boom) {
		t.Fatalf("transaction error = %v, want the callback error", err)
	}
	if accountExists(t, db, transactionTenant, 1) {
		t.Fatal("the rolled back row exists")
	}
}

// TestCoverageTransactionSavepoint checks that a failed nested transaction rolls back only to its savepoint
// and the outer transaction is committed.
// Requirements: DSL-119, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-47, INT-48, PLN-17, PLN-44.
func TestCoverageTransactionSavepoint(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, driver, _ := connectFeature(t)
	requireNoTransactionRows(t, db)
	boom := errors.New("transaction_savepoint")
	err := db.Transaction(func() error {
		if _, err := model.CompositeAccount().SetTenantId(transactionTenant).SetAccountId(2).SetName("outer").Create(); err != nil {
			return err
		}
		inner := db.Transaction(func() error {
			if _, err := model.CompositeAccount().SetTenantId(transactionTenant).SetAccountId(3).SetName("inner").Create(); err != nil {
				return err
			}
			return boom
		}, orm.Retry(0))
		if !errors.Is(inner, boom) {
			return errors.Join(errors.New("nested transaction did not return its callback error"), inner)
		}
		return nil
	}, orm.Retry(0))
	if err != nil {
		t.Fatal(err)
	}
	if !accountExists(t, db, transactionTenant, 2) {
		t.Fatal("the committed outer row is missing")
	}
	if accountExists(t, db, transactionTenant, 3) {
		t.Fatal("the rolled back inner row exists")
	}
	if err := must(model.CompositeAccount().Connect(db).GetByTenantIdAndAccountId(transactionTenant, 2)).Delete(); err != nil {
		t.Fatal(err)
	}
	if accountExists(t, db, transactionTenant, 2) {
		t.Fatal("the outer row was not deleted")
	}
	flowErr := db.Transaction(func() error {
		otherFlow := make(chan error, 1)
		go func() {
			_, err := model.CompositeAccount().GetCount()
			otherFlow <- err
		}()
		if err := <-otherFlow; orm.ErrorCode(err) != orm.CodeConfig {
			return fmt.Errorf("goroutine inherited the transaction: %w", err)
		}
		return nil
	}, orm.Retry(0))
	if flowErr != nil {
		t.Fatalf("goroutine transaction isolation: %v", flowErr)
	}
	for _, level := range []orm.IsolationLevel{orm.ReadUncommitted, orm.ReadCommitted, orm.RepeatableRead, orm.Serializable} {
		if err := db.Transaction(func() error { return nil }, orm.Isolation(level), orm.Retry(0)); err != nil {
			t.Fatalf("%s transaction: %v", level, err)
		}
	}
	readOnlyErr := db.Transaction(func() error {
		_, err := model.CompositeAccount().SetTenantId(transactionTenant).SetAccountId(4).SetName("read only").Create()
		return err
	}, orm.ReadOnly(), orm.Retry(0))
	if orm.ErrorCode(readOnlyErr) != orm.CodeReadOnly || accountExists(t, db, transactionTenant, 4) {
		t.Fatalf("read-only transaction = %v, row exists = %v", readOnlyErr, accountExists(t, db, transactionTenant, 4))
	}
	timeoutCalls := 0
	timeoutErr := db.Transaction(func() error { timeoutCalls++; return nil }, orm.TimeoutMs(500), orm.Retry(0))
	if driver == "postgres" {
		if timeoutErr != nil || timeoutCalls != 1 {
			t.Fatalf("PostgreSQL timeoutMs transaction calls = %d, error = %v", timeoutCalls, timeoutErr)
		}
	} else if orm.ErrorCode(timeoutErr) != orm.CodeCapabilityUnsupported || timeoutCalls != 0 {
		t.Fatalf("%s timeoutMs calls = %d, error = %v, want CAPABILITY_UNSUPPORTED before callback", driver, timeoutCalls, timeoutErr)
	}
	if driver == "postgres" {
		if _, err := model.CompositeAccount().Connect(db).SetTenantId(transactionTenant).SetAccountId(6).SetName("before timeout").Create(); err != nil {
			t.Fatal(err)
		}
		holderDB, _, _ := connectFeature(t)
		locked := make(chan error, 1)
		release := make(chan struct{})
		var releaseOnce sync.Once
		releaseHolder := func() { releaseOnce.Do(func() { close(release) }) }
		holderDone := make(chan error, 1)
		go func() {
			holderDone <- holderDB.Transaction(func() error {
				_, err := model.CompositeAccount().Connect(holderDB).TenantId(transactionTenant).ForUpdate().Get()
				if err != nil {
					locked <- err
					return err
				}
				locked <- nil
				<-release
				return nil
			}, orm.Retry(0))
		}()
		if err := <-locked; err != nil {
			releaseHolder()
			t.Fatalf("acquire timeout probe row lock: %v", err)
		}
		updateStarted := make(chan struct{})
		updateDone := make(chan error, 1)
		go func() {
			updateDone <- db.Transaction(func() error {
				close(updateStarted)
				_, err := model.CompositeAccount().Connect(db).TenantId(transactionTenant).SetName("timed out").Update()
				return err
			}, orm.TimeoutMs(250), orm.Retry(0))
		}()
		<-updateStarted
		releaseTimer := time.AfterFunc(time.Second, releaseHolder)
		timeoutUpdateErr := <-updateDone
		releaseTimer.Stop()
		releaseHolder()
		if err := <-holderDone; err != nil {
			t.Fatalf("row lock holder transaction: %v", err)
		}
		if orm.ErrorCode(timeoutUpdateErr) != orm.CodeCanceled {
			t.Fatalf("locked update with timeoutMs = %v, want CANCELED", timeoutUpdateErr)
		}
		if row := must(model.CompositeAccount().Connect(db).GetByTenantIdAndAccountId(transactionTenant, 6)); readColumn(t, row.GetName) != "before timeout" {
			t.Fatalf("timed out update changed row to %q", readColumn(t, row.GetName))
		}
		if err := must(model.CompositeAccount().Connect(db).GetByTenantIdAndAccountId(transactionTenant, 6)).Delete(); err != nil {
			t.Fatal(err)
		}
	}
	attempts := 0
	retryErr := db.Transaction(func() error {
		attempts++
		if _, err := model.CompositeAccount().SetTenantId(transactionTenant).SetAccountId(5).SetName(fmt.Sprintf("attempt-%d", attempts)).Create(); err != nil {
			return err
		}
		if attempts < 3 {
			return orm.TransactionConflict("coverage retry")
		}
		return nil
	}, orm.Isolation(orm.ReadCommitted), orm.Retry(3))
	if retryErr != nil || attempts != 3 {
		t.Fatalf("retry attempts = %d, error = %v", attempts, retryErr)
	}
	if got := readColumn(t, must(model.CompositeAccount().Connect(db).GetByTenantIdAndAccountId(transactionTenant, 5)).GetName); got != "attempt-3" {
		t.Fatalf("committed retry row = %q, want final callback attempt", got)
	}
	if err := must(model.CompositeAccount().Connect(db).GetByTenantIdAndAccountId(transactionTenant, 5)).Delete(); err != nil {
		t.Fatal(err)
	}
	defaultAttempts := 0
	err = db.Transaction(func() error {
		defaultAttempts++
		if defaultAttempts < 3 {
			return orm.TransactionConflict("default coverage retry")
		}
		return nil
	})
	if err != nil || defaultAttempts != 3 {
		t.Fatalf("default retry attempts = %d, error = %v", defaultAttempts, err)
	}
	attempts = 0
	retryErr = db.Transaction(func() error {
		attempts++
		return orm.TransactionConflict("coverage retry disabled")
	}, orm.Retry(0))
	if orm.ErrorCode(retryErr) != orm.CodeDeadlock || attempts != 1 {
		t.Fatalf("retry=0 attempts = %d, error = %v", attempts, retryErr)
	}
}
