//go:build featurecoverage

package model_test

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/orm-go/model"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

// transactionTenant는 이 case들이 쓰는 composite_account의 tenant_id다.
const transactionTenant = 990003

// requireNoTransactionRows는 tenant 행이 없음을 확인하고, case가 끝날 때 남은
// 행을 지우게 한다.
func requireNoTransactionRows(t *testing.T, db *orm.DB) {
	t.Helper()
	if n := must(model.CompositeAccount().Connect(db).TenantId(transactionTenant).GetCount()); n != 0 {
		t.Fatalf("composite_account already has %d rows of tenant %d", n, transactionTenant)
	}
	t.Cleanup(func() { removeTenantAccounts(t, db, transactionTenant) })
}

// accountExists는 composite_account (tenant, account)가 있는지 읽는다.
func accountExists(t *testing.T, db *orm.DB, tenant, account int64) bool {
	t.Helper()
	_, err := model.CompositeAccount().Connect(db).GetByTenantIdAndAccountId(tenant, account)
	if err == nil {
		return true
	}
	if orm.ErrorCode(err) != orm.CodeNoRows {
		t.Fatal(err)
	}
	return false
}

// TestCoverageTransactionRollback는 callback이 error를 반환한 transaction이
// 그 error를 호출자에게 전하고 callback의 쓰기를 되돌리는지 확인한다.
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

// TestCoverageTransactionSavepoint는 실패한 nested transaction이 savepoint까지만
// 되돌리고 바깥 transaction은 commit되는지 확인한다.
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
