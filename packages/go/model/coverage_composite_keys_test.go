//go:build featurecoverage

package model_test

import (
	"fmt"
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/testcase"
)

// compositeTenant and compositeOtherTenant are the tenant_id of composite_account that this case uses.
// tenant_id. Account 2 must also exist in another tenant, so that a relation linked by
// the account_id component alone is revealed.
const (
	compositeTenant               = 990004
	compositeOtherTenant          = 990006
	compositeCollisionTenant      = 9900041
	compositeCollisionOtherTenant = 99000412
)

// TestCoverageCompositeKeyRows creates the account and
// membership rows with a two-column primary key, and reads them by the two key components,
// and reads them together through the memberships relation linked by (tenant_id, account_id),
// and checks that deleting an account cascades to delete its membership (ON DELETE CASCADE).
func TestCoverageCompositeKeyRows(t *testing.T) {
	// Requirements: PRT-12.
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	account := func() *model.CompositeAccountModel { return model.CompositeAccount().Connect(db) }
	membership := func() *model.CompositeMembershipModel { return model.CompositeMembership().Connect(db) }
	for _, tenant := range []int64{compositeTenant, compositeOtherTenant, compositeCollisionTenant, compositeCollisionOtherTenant} {
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
	must(account().SetTenantId(compositeCollisionTenant).SetAccountId(23).SetName("collision-a").Create())
	must(account().SetTenantId(compositeCollisionOtherTenant).SetAccountId(3).SetName("collision-b").Create())
	must(membership().SetTenantId(compositeCollisionTenant).SetAccountId(23).SetRole("collision-a-role").Create())
	must(membership().SetTenantId(compositeCollisionOtherTenant).SetAccountId(3).SetRole("collision-b-role").Create())

	if got := readColumn(t, must(account().GetByTenantIdAndAccountId(compositeTenant, 2)).GetName); got != "b" {
		t.Fatalf("account (%d, 2) name = %q, want b", compositeTenant, got)
	}
	for path, child := range map[string]*model.CompositeMembershipModel{
		"same statement": model.CompositeMembership(),
		"own connection": model.CompositeMembership().Connect(db),
	} {
		if fmt.Sprintf("%d%d", compositeCollisionTenant, 23) != fmt.Sprintf("%d%d", compositeCollisionOtherTenant, 3) {
			t.Fatal("collision fixture does not have equal concatenated composite keys")
		}
		loaded := must(account().TupleTenantIdWithAccountId([]model.CompositeAccountTenantIdWithAccountId{
			{TenantId: compositeCollisionTenant, AccountId: 23},
			{TenantId: compositeCollisionOtherTenant, AccountId: 3},
		}).OrderByTenantIdAsc().OrderByAccountIdAsc().Relations(child.MatchTenantIdWithTenantId().MatchAccountIdWithAccountId().AliasMemberships()).Gets())
		var got []string
		for _, a := range loaded.Slice() {
			for _, m := range must(a.GetMemberships()).Slice() {
				got = append(got, fmt.Sprintf("%d/%d:%d/%d/%s", readColumn(t, a.GetTenantId), readColumn(t, a.GetAccountId), readColumn(t, m.GetTenantId), readColumn(t, m.GetAccountId), readColumn(t, m.GetRole)))
			}
		}
		want := []string{
			"9900041/23:9900041/23/collision-a-role",
			"99000412/3:99000412/3/collision-b-role",
		}
		if !slices.Equal(got, want) {
			t.Fatalf("%s: colliding concatenated composite keys assembled relations = %v, want %v", path, got, want)
		}
	}
	// The relation links both components of the foreign key in key order. Linking only one component
	// attaches the memberships of another account in the tenant, or of account 2 in another tenant.
	// A child whose relation has its own link reads the parent row first and then reads separately. The two paths give the same result.
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
				got = append(got, fmt.Sprintf("%d/%d:%d/%d/%s", readColumn(t, a.GetTenantId), readColumn(t, a.GetAccountId), readColumn(t, m.GetTenantId), readColumn(t, m.GetAccountId), readColumn(t, m.GetRole)))
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
	for _, tenant := range []int64{compositeTenant, compositeOtherTenant, compositeCollisionTenant, compositeCollisionOtherTenant} {
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
