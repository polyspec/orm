//go:build featurecoverage

package model_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// writeTenant is the tenant_id of composite_account that this case writes.
const writeTenant = 990002

// TestCoverageModelWriteCycle creates rows with the generated CompositeAccount model,
// creates several rows, updates them, upserts with duplication, counts, and deletes.
// Deleting all the rows written returns the database to its initial state.
func TestCoverageModelWriteCycle(t *testing.T) {
	testcase.Start(t, testcase.Database)
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

// removeTenantAccounts deletes the composite_account rows of the tenant that a failed case left
// behind. Memberships are deleted along with them through ON DELETE CASCADE. If any row was deleted,
// the case did not finish its cleanup, so it reports failure.
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
