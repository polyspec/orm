//go:build featurecoverage

package model_test

import (
	"fmt"
	"slices"
	"testing"

	"github.com/polyspec/orm/clients/go/model"
)

// compositeTenant와 compositeOtherTenant는 이 case가 쓰는 composite_account의
// tenant_id다. 다른 tenant에도 account 2가 있어야 account_id 한 성분만으로
// 잇는 relation이 드러난다.
const (
	compositeTenant      = 990004
	compositeOtherTenant = 990006
)

// TestCoverageCompositeKeyRows는 두 column primary key의 account와
// membership을 만들고, 두 key 성분으로 읽고, foreign key의 두 성분
// (tenant_id, account_id)으로 잇는 memberships relation으로 함께 읽고,
// account를 지우면 ON DELETE CASCADE로 membership이 지워지는지 확인한다.
func TestCoverageCompositeKeyRows(t *testing.T) {
	db, _, _ := connectFeature(t)
	account := func() *model.CompositeAccountModel { return model.CompositeAccount().Connect(db) }
	membership := func() *model.CompositeMembershipModel { return model.CompositeMembership().Connect(db) }
	for _, tenant := range []int64{compositeTenant, compositeOtherTenant} {
		if n := must(account().TenantId(tenant).GetCount()); n != 0 {
			t.Fatalf("composite_account already has %d rows of tenant %d", n, tenant)
		}
		if n := must(membership().TenantId(tenant).GetCount()); n != 0 {
			t.Fatalf("composite_membership already has %d rows of tenant %d", n, tenant)
		}
		t.Cleanup(func() { removeTenantAccounts(t, db, tenant) })
	}

	must(account().SetTenantId(compositeTenant).SetAccountId(1).SetName("a").Create())
	must(account().SetTenantId(compositeTenant).SetAccountId(2).SetName("b").Create())
	must(account().SetTenantId(compositeOtherTenant).SetAccountId(2).SetName("c").Create())
	must(membership().SetTenantId(compositeTenant).SetAccountId(1).SetRole("member").Create())
	must(membership().SetTenantId(compositeTenant).SetAccountId(2).SetRole("owner").Create())
	must(membership().SetTenantId(compositeOtherTenant).SetAccountId(2).SetRole("guest").Create())

	if got := must(account().GetByTenantIdAndAccountId(compositeTenant, 2)).GetName(); got != "b" {
		t.Fatalf("account (%d, 2) name = %q, want b", compositeTenant, got)
	}
	// relation은 foreign key의 두 성분을 key 순서대로 잇는다. 한 성분만 이으면
	// tenant의 다른 account나 다른 tenant의 account 2의 membership이 붙는다.
	// 자식이 자기 연결을 가진 relation은 부모 row를 읽은 뒤 따로 읽는다. 두 경로가 같은 결과를 낸다.
	for path, child := range map[string]*model.CompositeMembershipModel{
		"same statement": model.CompositeMembership(),
		"own connection": model.CompositeMembership().Connect(db),
	} {
		loaded := must(account().TenantId(compositeTenant).
			Relations(child.MatchTenantIdWithTenantId().MatchAccountIdWithAccountId().AliasMemberships()).
			Gets())
		var got []string
		for _, a := range loaded.Slice() {
			for _, m := range must(a.GetMemberships()).Slice() {
				got = append(got, fmt.Sprintf("%d/%d:%d/%d/%s", a.GetTenantId(), a.GetAccountId(), m.GetTenantId(), m.GetAccountId(), m.GetRole()))
			}
		}
		want := []string{"990004/1:990004/1/member", "990004/2:990004/2/owner"}
		if !slices.Equal(got, want) {
			t.Fatalf("%s: memberships of tenant %d accounts = %v, want %v", path, compositeTenant, got, want)
		}
	}

	if err := must(account().GetByTenantIdAndAccountId(compositeTenant, 2)).Delete(); err != nil {
		t.Fatal(err)
	}
	if n := must(membership().TenantId(compositeTenant).GetCount()); n != 1 {
		t.Fatalf("tenant %d memberships after deleting account 2 = %d, want 1", compositeTenant, n)
	}
	for _, tenant := range []int64{compositeTenant, compositeOtherTenant} {
		if err := must(account().TenantId(tenant).Gets()).Delete(); err != nil {
			t.Fatal(err)
		}
		if n := must(account().TenantId(tenant).GetCount()); n != 0 {
			t.Fatalf("tenant %d accounts remain: %d", tenant, n)
		}
		if n := must(membership().TenantId(tenant).GetCount()); n != 0 {
			t.Fatalf("tenant %d memberships remain: %d", tenant, n)
		}
	}
}
