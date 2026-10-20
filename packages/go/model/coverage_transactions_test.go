//go:build featurecoverage

package model_test

import (
	"errors"
	"testing"

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
// Requirements: PLN-13, PLN-20.
// Requirements: INT-45.
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
// Requirements: PLN-17.
// Requirements: INT-45, INT-46.
func TestCoverageTransactionSavepoint(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
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
}
