//go:build featurecoverage

package model_test

import (
	"testing"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

// writeTenant는 이 case가 쓰는 composite_account의 tenant_id다.
const writeTenant = 990002

// TestCoverageModelWriteCycle는 generated CompositeAccount model로 만들고,
// 여러 행을 만들고, 고치고, duplication으로 upsert하고, 세고, 지운다. 쓴
// 행은 모두 지워 database가 처음과 같아진다.
func TestCoverageModelWriteCycle(t *testing.T) {
	db, _, _ := connectFeature(t)
	account := func() *model.CompositeAccountModel { return model.CompositeAccount().Connect(db) }
	if n := must(account().TenantId(writeTenant).GetCount()); n != 0 {
		t.Fatalf("composite_account already has %d rows of tenant %d", n, writeTenant)
	}
	t.Cleanup(func() { removeTenantAccounts(t, db, writeTenant) })

	created := must(account().SetTenantId(writeTenant).SetAccountId(1).SetName("created").Create())
	if created.GetTenantId() != writeTenant || created.GetAccountId() != 1 || created.GetName() != "created" {
		t.Fatalf("created row = %d %d %q", created.GetTenantId(), created.GetAccountId(), created.GetName())
	}
	many := []*model.CompositeAccountModel{
		model.CompositeAccount().SetTenantId(writeTenant).SetAccountId(2).SetName("many-2"),
		model.CompositeAccount().SetTenantId(writeTenant).SetAccountId(3).SetName("many-3"),
		model.CompositeAccount().SetTenantId(writeTenant).SetAccountId(4).SetName("many-4"),
	}
	if n := must(account().Creates(many)); n != 3 {
		t.Fatalf("creates inserted %d rows, want 3", n)
	}
	for id, name := range map[int64]string{2: "many-2", 3: "many-3", 4: "many-4"} {
		if got := must(account().GetByTenantIdAndAccountId(writeTenant, id)).GetName(); got != name {
			t.Fatalf("account %d name = %q, want %q", id, got, name)
		}
	}

	row := must(account().GetByTenantIdAndAccountId(writeTenant, 1))
	must(row.SetName("updated").Update())
	if got := must(account().GetByTenantIdAndAccountId(writeTenant, 1)).GetName(); got != "updated" {
		t.Fatalf("updated name = %q, want updated", got)
	}

	must(account().SetTenantId(writeTenant).SetAccountId(1).SetName("ignored").
		Duplication(model.CompositeAccount().SetName("upserted")).Create())
	if got := must(account().GetByTenantIdAndAccountId(writeTenant, 1)).GetName(); got != "upserted" {
		t.Fatalf("upserted name = %q, want upserted", got)
	}
	if n := must(account().TenantId(writeTenant).GetCount()); n != 4 {
		t.Fatalf("tenant %d count = %d, want 4", writeTenant, n)
	}

	rows := must(account().TenantId(writeTenant).Gets())
	if rows.Len() != 4 {
		t.Fatalf("tenant %d rows = %d, want 4", writeTenant, rows.Len())
	}
	if err := rows.Delete(); err != nil {
		t.Fatal(err)
	}
	if got, err := account().GetByTenantIdAndAccountId(writeTenant, 1); got != nil || orm.ErrorCode(err) != orm.CodeNoRows {
		t.Fatalf("get after delete = %v, %v; want NO_ROWS", got, err)
	}
	if n := must(account().TenantId(writeTenant).GetCount()); n != 0 {
		t.Fatalf("tenant %d count after delete = %d, want 0", writeTenant, n)
	}
}

// removeTenantAccounts는 실패한 case가 남긴 tenant의 composite_account 행을
// 지운다. membership은 ON DELETE CASCADE로 함께 지워진다. 지운 행이 있으면
// case가 끝까지 정리하지 못한 것이므로 실패로 알린다.
func removeTenantAccounts(t *testing.T, db *orm.DB, tenant int64) {
	t.Helper()
	rows, err := model.CompositeAccount().Connect(db).TenantId(tenant).Gets()
	if err != nil {
		t.Errorf("read tenant %d accounts for cleanup: %v", tenant, err)
		return
	}
	if rows.Len() == 0 {
		return
	}
	t.Errorf("tenant %d left %d composite_account rows; removing them", tenant, rows.Len())
	if err := rows.Delete(); err != nil {
		t.Errorf("remove tenant %d accounts: %v", tenant, err)
	}
}
