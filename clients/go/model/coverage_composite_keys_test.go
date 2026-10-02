//go:build featurecoverage

package model_test

import (
	"testing"

	"github.com/polyspec/orm/clients/go/model"
)

// compositeTenant는 이 case가 쓰는 composite_account의 tenant_id다.
const compositeTenant = 990004

// TestCoverageCompositeKeyRows는 두 column primary key의 account와
// membership을 만들고, 두 key 성분으로 읽고, memberships relation으로 함께
// 읽고, account를 지우면 ON DELETE CASCADE로 membership이 지워지는지 확인한다.
func TestCoverageCompositeKeyRows(t *testing.T) {
	db, _, _ := connectFeature(t)
	account := func() *model.CompositeAccountModel { return model.CompositeAccount().Connect(db) }
	membership := func() *model.CompositeMembershipModel { return model.CompositeMembership().Connect(db) }
	if n := must(account().TenantId(compositeTenant).GetCount()); n != 0 {
		t.Fatalf("composite_account already has %d rows of tenant %d", n, compositeTenant)
	}
	if n := must(membership().TenantId(compositeTenant).GetCount()); n != 0 {
		t.Fatalf("composite_membership already has %d rows of tenant %d", n, compositeTenant)
	}
	t.Cleanup(func() { removeTenantAccounts(t, db, compositeTenant) })

	must(account().SetTenantId(compositeTenant).SetAccountId(1).SetName("a").Create())
	must(account().SetTenantId(compositeTenant).SetAccountId(2).SetName("b").Create())
	must(membership().SetTenantId(compositeTenant).SetAccountId(2).SetRole("owner").Create())

	if got := must(account().GetByTenantIdAndAccountId(compositeTenant, 2)).GetName(); got != "b" {
		t.Fatalf("account (%d, 2) name = %q, want b", compositeTenant, got)
	}
	// relation은 IR에서 key 한 쌍으로 이어지므로 account_id로 잇고 tenant_id는
	// child 조건으로 고정한다.
	loaded := must(account().
		Relations(model.CompositeMembership().MatchAccountIdWithAccountId().TenantId(compositeTenant).AliasMemberships()).
		GetByTenantIdAndAccountId(compositeTenant, 2))
	members := loaded.GetMemberships()
	if members.Len() != 1 || members.First().GetRole() != "owner" ||
		members.First().GetTenantId() != compositeTenant || members.First().GetAccountId() != 2 {
		t.Fatalf("memberships of (%d, 2) = %d rows", compositeTenant, members.Len())
	}

	if err := loaded.Delete(); err != nil {
		t.Fatal(err)
	}
	if n := must(membership().TenantId(compositeTenant).GetCount()); n != 0 {
		t.Fatalf("membership of the deleted account remains: %d rows", n)
	}
	if err := must(account().GetByTenantIdAndAccountId(compositeTenant, 1)).Delete(); err != nil {
		t.Fatal(err)
	}
	if n := must(account().TenantId(compositeTenant).GetCount()); n != 0 {
		t.Fatalf("tenant %d accounts remain: %d", compositeTenant, n)
	}
	if n := must(membership().TenantId(compositeTenant).GetCount()); n != 0 {
		t.Fatalf("tenant %d memberships remain: %d", compositeTenant, n)
	}
}
