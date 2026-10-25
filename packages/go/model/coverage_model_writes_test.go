//go:build featurecoverage

package model_test

import (
	"fmt"
	"os"
	"slices"
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
// Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-110.
func TestCoverageModelWriteCycle(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	account := func() *model.CompositeAccountModel { return model.CompositeAccount().Connect(db) }
	if n := must(account().TenantId(writeTenant).GetCount()); n != 0 {
		t.Fatalf("composite_account already has %d rows of tenant %d", n, writeTenant)
	}
	t.Cleanup(func() { removeTenantAccounts(t, db, writeTenant) })

	created := must(account().SetTenantId(writeTenant).SetAccountId(1).SetName("created").Create())
	if readColumn(t, created.GetTenantId) != writeTenant || readColumn(t, created.GetAccountId) != 1 || readColumn(t, created.GetName) != "created" {
		t.Fatalf("created row = %d %d %q", readColumn(t, created.GetTenantId), readColumn(t, created.GetAccountId), readColumn(t, created.GetName))
	}
	many := []*model.CompositeAccountModel{
		model.CompositeAccount().SetTenantId(writeTenant).SetAccountId(2).SetName("many-2"),
		model.CompositeAccount().SetTenantId(writeTenant).SetAccountId(3).SetName("many-3"),
		model.CompositeAccount().SetTenantId(writeTenant).SetAccountId(4).SetName("many-4"),
	}
	if n := must(account().Creates(many, 2)); n != 3 {
		t.Fatalf("creates inserted %d rows, want 3", n)
	}
	for id, name := range map[int64]string{2: "many-2", 3: "many-3", 4: "many-4"} {
		if got := readColumn(t, must(account().GetByTenantIdAndAccountId(writeTenant, id)).GetName); got != name {
			t.Fatalf("account %d name = %q, want %q", id, got, name)
		}
	}

	row := must(account().GetByTenantIdAndAccountId(writeTenant, 1))
	must(row.SetName("updated").Update())
	if got := readColumn(t, must(account().GetByTenantIdAndAccountId(writeTenant, 1)).GetName); got != "updated" {
		t.Fatalf("updated name = %q, want updated", got)
	}

	must(account().SetTenantId(writeTenant).SetAccountId(1).SetName("ignored").
		Duplication(model.CompositeAccount().SetName("upserted")).Create())
	if got := readColumn(t, must(account().GetByTenantIdAndAccountId(writeTenant, 1)).GetName); got != "upserted" {
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
	if got, err := account().GetByTenantIdAndAccountId(writeTenant, 1); got != nil || err != nil {
		t.Fatalf("get after delete = %v, %v; want nil, nil", got, err)
	}
	if n := must(account().TenantId(writeTenant).GetCount()); n != 0 {
		t.Fatalf("tenant %d count after delete = %d, want 0", writeTenant, n)
	}
}

// TestCoverageModelArithmeticAttributes checks bound plus/minus assignments, the zero clamp, and that update clears
// the pending assignment after it is written. The scratch composite_account row is removed before leaving.
// Requirements: PLN-26.
func TestCoverageModelArithmeticAttributes(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	tenant := int64(1_000_000_000_000 + os.Getpid())
	account := func() *model.CompositeAccountModel { return model.CompositeAccount().Connect(db) }
	if n := must(account().TenantId(tenant).GetCount()); n != 0 {
		t.Fatalf("scratch tenant %d already has %d rows", tenant, n)
	}
	t.Cleanup(func() { removeTenantAccounts(t, db, tenant) })
	if _, err := account().SetTenantId(tenant).SetAccountId(1).SetName("arithmetic").Create(); err != nil {
		t.Fatal(err)
	}
	loaded := must(account().GetByTenantIdAndAccountId(tenant, 1))
	recorder := testcase.NewEventRecorder[orm.StatementEvent]()
	unsubscribe, err := db.Subscribe(recorder.Record)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	hasBind := func(want int64) bool {
		for _, event := range recorder.Events() {
			if event.Kind != orm.KindUpdate || !slices.Contains(event.Tables, "composite_account") {
				continue
			}
			for _, bind := range event.Binds {
				if fmt.Sprint(bind) == fmt.Sprint(want) {
					return true
				}
			}
		}
		return false
	}
	if _, err := loaded.PlusAccountId(7).Update(); err != nil {
		t.Fatal(err)
	}
	if got := readColumn(t, must(account().GetByTenantIdAndAccountId(tenant, 8)).GetName); got != "arithmetic" {
		t.Fatalf("row after plus = %q, want arithmetic", got)
	}
	if !hasBind(7) {
		t.Fatalf("plus amount is not present in update binds: %#v", recorder.Events())
	}
	if _, err := loaded.Update(); err != nil {
		t.Fatal(err)
	}
	updates := 0
	for _, event := range recorder.Events() {
		if event.Kind == orm.KindUpdate && slices.Contains(event.Tables, "composite_account") {
			updates++
		}
	}
	if updates != 1 {
		t.Fatalf("updates after repeating a completed write = %d, want 1", updates)
	}
	current := must(account().GetByTenantIdAndAccountId(tenant, 8))
	amount := readColumn(t, current.GetAccountId) + 1
	if _, err := current.MinusAccountId(amount).Update(); err != nil {
		t.Fatalf("minus %d: %v", amount, err)
	}
	if got := readColumn(t, must(account().GetByTenantIdAndAccountId(tenant, 0)).GetName); got != "arithmetic" {
		t.Fatalf("row after minus = %q, want zero-clamped arithmetic row", got)
	}
	if !hasBind(int64(amount)) {
		t.Fatalf("minus amount %d is not present in update binds: %#v", amount, recorder.Events())
	}
	rows := must(account().TenantId(tenant).Gets())
	if err := rows.Delete(); err != nil {
		t.Fatal(err)
	}
	if n := must(account().TenantId(tenant).GetCount()); n != 0 {
		t.Fatalf("scratch tenant %d leaves %d rows", tenant, n)
	}
}

// TestCoverageModelCreateParts checks that multi-row creates refuse an invalid batch before writing, preserve row order
// across batches, and roll back earlier batches when a later batch fails.
// Requirements: DSL-104, INT-35, PRT-41.
func TestCoverageModelCreateParts(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, driver, _ := connectFeature(t)
	const tenant int64 = writeTenant + 1
	account := func() *model.CompositeAccountModel { return model.CompositeAccount().Connect(db) }
	cleanup := func() {
		rows, err := account().TenantId(tenant).Gets()
		if err != nil {
			t.Errorf("read create_parts rows for cleanup: %v", err)
			return
		}
		if err := rows.Delete(); err != nil {
			t.Errorf("delete create_parts rows: %v", err)
		}
	}
	t.Cleanup(cleanup)
	if n := must(account().TenantId(tenant).GetCount()); n != 0 {
		t.Fatalf("composite_account has %d rows of tenant %d before the case", n, tenant)
	}

	recorder := testcase.NewEventRecorder[orm.StatementEvent]()
	unsubscribe, err := db.Subscribe(recorder.Record)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	rows := func(start, count int, prefix string) []*model.CompositeAccountModel {
		result := make([]*model.CompositeAccountModel, count)
		for i := range result {
			id := int64(start + i)
			result[i] = model.CompositeAccount().SetTenantId(tenant).SetAccountId(id).SetName(fmt.Sprintf("%s-%d", prefix, id))
		}
		return result
	}
	if _, err := account().Creates(rows(1, 2, "refused"), 0); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("creates with batch 0 = %v, want CONFIG", err)
	}
	limit := 65535
	if driver == "sqlite" {
		limit = 999
	}
	oversized := make([]*model.CompositeAccountModel, limit/3+1)
	row := model.CompositeAccount().SetTenantId(tenant).SetAccountId(8).SetName("oversized")
	for i := range oversized {
		oversized[i] = row
	}
	if _, err := account().Creates(oversized, len(oversized)); orm.ErrorCode(err) != orm.CodeBatchTooLarge {
		t.Fatalf("creates over the %s bind limit = %v, want BATCH_TOO_LARGE", driver, err)
	}
	if len(recorder.Events()) != 0 {
		t.Fatalf("refused creates sent %d statements, want none", len(recorder.Events()))
	}

	labels := []string{"ordered-5", "ordered-4", "ordered-3", "ordered-2", "ordered-1"}
	ordered := make([]*model.CompositeAccountModel, len(labels))
	for i, label := range labels {
		ordered[i] = model.CompositeAccount().SetTenantId(tenant).SetAccountId(int64(i + 1)).SetName(label)
	}
	if n, err := account().Creates(ordered, 2); err != nil || n != int64(len(ordered)) {
		t.Fatalf("creates ordered rows = %d, %v; want %d", n, err, len(ordered))
	}
	var sizes []int
	for _, event := range recorder.Events() {
		if event.Kind == orm.KindInsert && slices.Contains(event.Tables, "composite_account") {
			sizes = append(sizes, len(event.Binds)/3)
		}
	}
	if !slices.Equal(sizes, []int{2, 2, 1}) {
		t.Fatalf("create_parts INSERT sizes = %v, want [2 2 1]", sizes)
	}
	for i, label := range labels {
		got := readColumn(t, must(account().GetByTenantIdAndAccountId(tenant, int64(i+1))).GetName)
		if got != label {
			t.Fatalf("stored row %d name = %q, want %q", i+1, got, label)
		}
	}
	if err := must(account().TenantId(tenant).Gets()).Delete(); err != nil {
		t.Fatal(err)
	}
	recorder.Reset()

	if _, err := account().SetTenantId(tenant).SetAccountId(99).SetName("existing").Create(); err != nil {
		t.Fatalf("create rollback sentinel: %v", err)
	}
	recorder.Reset()
	rollback := append(rows(10, 4, "rollback"), model.CompositeAccount().SetTenantId(tenant).SetAccountId(99).SetName("duplicate"))
	if _, err := account().Creates(rollback, 2); orm.ErrorCode(err) != orm.CodeDuplicateKey {
		t.Fatalf("creates with duplicate in third batch = %v, want DUPLICATE_KEY", err)
	}
	var failedInsertSizes []int
	for _, event := range recorder.Events() {
		if event.Kind == orm.KindInsert && slices.Contains(event.Tables, "composite_account") {
			failedInsertSizes = append(failedInsertSizes, len(event.Binds)/3)
		}
	}
	if !slices.Equal(failedInsertSizes, []int{2, 2, 1}) {
		t.Fatalf("rollback INSERT sizes = %v, want [2 2 1]", failedInsertSizes)
	}
	if n := must(account().TenantId(tenant).GetCount()); n != 1 {
		t.Fatalf("rows after failed create_parts = %d, want only the sentinel", n)
	}
	if got := readColumn(t, must(account().GetByTenantIdAndAccountId(tenant, 99)).GetName); got != "existing" {
		t.Fatalf("sentinel name after rollback = %q, want existing", got)
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
