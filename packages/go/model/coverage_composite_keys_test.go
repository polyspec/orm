//go:build featurecoverage

package model_test

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// compositeTenant and compositeOtherTenant are the tenant_id of composite_account that this case uses.
// tenant_id. Account 2 must also exist in another tenant, so that a relation linked by
// the account_id component alone is revealed.
const (
	compositeTenant      = 990004
	compositeOtherTenant = 990006
)

type compositeCollisionRow struct {
	TenantID  int64  `json:"tenant_id"`
	AccountID int64  `json:"account_id"`
	Name      string `json:"name"`
	Role      string `json:"role"`
}

func readCompositeCollisionRows(t *testing.T) []compositeCollisionRow {
	t.Helper()
	workspace, err := exec.Command("go", "env", "GOWORK").Output()
	if err != nil {
		t.Fatal(err)
	}
	workspacePath := strings.TrimSpace(string(workspace))
	if workspacePath == "" {
		t.Fatal("go env GOWORK did not locate the repository workspace")
	}
	fixturePath := filepath.Join("contracts", "fixtures", "composite_key_collision.json")
	root := filepath.Dir(workspacePath)
	for {
		if _, err := os.Stat(filepath.Join(root, fixturePath)); err == nil {
			break
		}
		parent := filepath.Dir(root)
		if parent == root {
			t.Fatalf("cannot locate %s above Go workspace %s", fixturePath, workspacePath)
		}
		root = parent
	}
	raw, err := os.ReadFile(filepath.Join(root, fixturePath))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Feature string `json:"feature"`
		Cases   []struct {
			ID        string                  `json:"id"`
			Operation string                  `json:"operation"`
			Expected  []compositeCollisionRow `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Feature != "composite_keys" || len(fixture.Cases) != 1 ||
		fixture.Cases[0].ID != "composite_key_rows" || fixture.Cases[0].Operation != "relation_assembly" ||
		len(fixture.Cases[0].Expected) != 2 {
		t.Fatalf("unexpected composite collision fixture: %+v", fixture)
	}
	return fixture.Cases[0].Expected
}

func compositeRelationRows(t *testing.T, accounts *orm.Collection[*model.CompositeAccountModel]) []string {
	var rows []string
	for _, account := range accounts.Slice() {
		for _, membership := range must(account.GetMemberships()).Slice() {
			rows = append(rows, fmt.Sprintf(
				"%d/%d:%d/%d/%s",
				readColumn(t, account.GetTenantId),
				readColumn(t, account.GetAccountId),
				readColumn(t, membership.GetTenantId),
				readColumn(t, membership.GetAccountId),
				readColumn(t, membership.GetRole),
			))
		}
	}
	return rows
}

func parentPlaceholderCount(sql string) int {
	if strings.Contains(sql, "?") {
		return strings.Count(sql, "?")
	}
	return len(regexp.MustCompile(`\$[0-9]+`).FindAllString(sql, -1))
}

// TestCoverageCompositeKeyRows creates the account and
// membership rows with a two-column primary key, and reads them by the two key components,
// and reads them together through the memberships relation linked by (tenant_id, account_id),
// and checks that deleting an account cascades to delete its membership (ON DELETE CASCADE).
func TestCoverageCompositeKeyRows(t *testing.T) {
	// Requirements: INT-87, PRT-12, PRT-40.
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	account := func() *model.CompositeAccountModel { return model.CompositeAccount().Connect(db) }
	membership := func() *model.CompositeMembershipModel { return model.CompositeMembership().Connect(db) }
	collisionRows := readCompositeCollisionRows(t)
	collisionTenants := []int64{collisionRows[0].TenantID, collisionRows[1].TenantID}
	for _, tenant := range append([]int64{compositeTenant, compositeOtherTenant}, collisionTenants...) {
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
	must(account().SetTenantId(compositeTenant).SetAccountId(3).SetName("d").Create())
	must(account().SetTenantId(compositeOtherTenant).SetAccountId(2).SetName("c").Create())
	must(membership().SetTenantId(compositeTenant).SetAccountId(1).SetRole("member").Create())
	must(membership().SetTenantId(compositeTenant).SetAccountId(2).SetRole("owner").Create())
	must(membership().SetTenantId(compositeTenant).SetAccountId(3).SetRole("editor").Create())
	must(membership().SetTenantId(compositeOtherTenant).SetAccountId(2).SetRole("guest").Create())
	for _, row := range collisionRows {
		must(account().SetTenantId(row.TenantID).SetAccountId(row.AccountID).SetName(row.Name).Create())
		must(membership().SetTenantId(row.TenantID).SetAccountId(row.AccountID).SetRole(row.Role).Create())
	}

	if got := readColumn(t, must(account().GetByTenantIdAndAccountId(compositeTenant, 2)).GetName); got != "b" {
		t.Fatalf("account (%d, 2) name = %q, want b", compositeTenant, got)
	}
	for path, child := range map[string]*model.CompositeMembershipModel{
		"same statement": model.CompositeMembership(),
		"own connection": model.CompositeMembership().Connect(db),
	} {
		loaded := must(account().TupleTenantIdWithAccountId([]model.CompositeAccountTenantIdWithAccountId{
			{TenantId: collisionRows[0].TenantID, AccountId: collisionRows[0].AccountID},
			{TenantId: collisionRows[1].TenantID, AccountId: collisionRows[1].AccountID},
		}).OrderByTenantIdAsc().OrderByAccountIdAsc().Relations(child.MatchTenantIdWithTenantId().MatchAccountIdWithAccountId().AliasMemberships()).Gets())
		got := compositeRelationRows(t, loaded)
		want := []string{
			fmt.Sprintf("%d/%d:%d/%d/%s", collisionRows[0].TenantID, collisionRows[0].AccountID, collisionRows[0].TenantID, collisionRows[0].AccountID, collisionRows[0].Role),
			fmt.Sprintf("%d/%d:%d/%d/%s", collisionRows[1].TenantID, collisionRows[1].AccountID, collisionRows[1].TenantID, collisionRows[1].AccountID, collisionRows[1].Role),
		}
		if !slices.Equal(got, want) {
			t.Fatalf("%s: colliding concatenated composite keys assembled relations = %v, want %v", path, got, want)
		}
	}
	// The relation links both components of the foreign key in key order. Linking only one component
	// attaches the memberships of another account in the tenant, or of account 2 in another tenant.
	// A child whose relation has its own link reads the parent row first and then reads separately. The two paths give the same result.
	var relationEvents []orm.StatementEvent
	unsubscribe, err := db.Subscribe(func(event orm.StatementEvent) error {
		if event.Kind == orm.KindSelect && strings.Contains(event.SQL, "composite_membership") && strings.Contains(event.SQL, " IN (") {
			relationEvents = append(relationEvents, event)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for path, child := range map[string]*model.CompositeMembershipModel{
		"same statement": model.CompositeMembership(),
		"own connection": model.CompositeMembership().Connect(db),
	} {
		loaded := must(account().TenantId(compositeTenant).
			Relations(child.MatchTenantIdWithTenantId().MatchAccountIdWithAccountId().AliasMemberships()).
			Gets())
		got := compositeRelationRows(t, loaded)
		want := []string{"990004/1:990004/1/member", "990004/2:990004/2/owner", "990004/3:990004/3/editor"}
		if !slices.Equal(got, want) {
			t.Fatalf("%s: memberships of tenant %d accounts = %v, want %v", path, compositeTenant, got, want)
		}
	}
	unsubscribe()
	wantParentBinds := []any{int64(compositeTenant), int64(1), int64(compositeTenant), int64(2), int64(compositeTenant), int64(3), int64(compositeTenant), int64(3)}
	if len(relationEvents) != 2 {
		t.Fatalf("padded relation statements = %d, want 2: %+v", len(relationEvents), relationEvents)
	}
	for _, event := range relationEvents {
		if !slices.Equal(event.Binds, wantParentBinds) {
			t.Fatalf("expanded parent binds = %#v, want %#v", event.Binds, wantParentBinds)
		}
		if got := parentPlaceholderCount(event.SQL); got != 8 {
			t.Fatalf("expanded parent placeholders = %d in %q, want 8", got, event.SQL)
		}
	}

	if err := must(account().GetByTenantIdAndAccountId(compositeTenant, 2)).Delete(); err != nil {
		t.Fatal(err)
	}
	if n := must(membership().TenantId(compositeTenant).GetCount()); n != 2 {
		t.Fatalf("tenant %d memberships after deleting account 2 = %d, want 2", compositeTenant, n)
	}
	for _, tenant := range append([]int64{compositeTenant, compositeOtherTenant}, collisionTenants...) {
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
