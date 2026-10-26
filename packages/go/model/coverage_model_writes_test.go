//go:build featurecoverage

package model_test

import (
	"encoding/json/jsontext"
	"errors"
	"fmt"
	"slices"
	"testing"

	orderedjson "github.com/polyspec/ordered-json/packages/go"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// writeTenant is the tenant_id of composite_account that this case writes.
const writeTenant = 990002

// TestCoverageModelWriteCycle creates rows with the generated CompositeAccount model,
// creates several rows, updates them, upserts with duplication, counts, and deletes.
// Deleting all the rows written returns the database to its initial state.
// Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-110, DIA-26, COD-11, COD-12, COD-15, COD-38.
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

	const jsonText = `{"b":1,"a":[],"c":{},"n":1.50}`
	rollback := errors.New("rollback ordered JSON text probe")
	err := db.Transaction(func() error {
		row, err := model.Author().Connect(db).AddAllColumns().GetBySeq(1)
		if err != nil {
			return err
		}
		if row == nil {
			return errors.New("seed author row 1 is missing")
		}
		row, err = row.SetJsonSetting(orm.Value(jsontext.Value(jsonText)))
		if err != nil {
			return err
		}
		if _, err := row.Update(); err != nil {
			return err
		}
		stored, err := model.Author().Connect(db).AddAllColumns().GetBySeq(1)
		if err != nil {
			return err
		}
		if stored == nil {
			return errors.New("seed author row 1 disappeared after ordered JSON update")
		}
		styled, err := stored.GetJsonSetting()
		if err != nil {
			return err
		}
		data, ok := styled.Data()
		if !ok {
			return errors.New("ordered JSON text read back as SQL NULL")
		}
		value, ok := data.(*orderedjson.Value)
		if !ok {
			return fmt.Errorf("ordered JSON value has type %T", data)
		}
		actual, err := orderedjson.Stringify(value)
		if err != nil {
			return err
		}
		if actual != jsonText {
			return fmt.Errorf("ordered JSON text = %s, want %s", actual, jsonText)
		}
		return rollback
	}, orm.Retry(0))
	if !errors.Is(err, rollback) {
		t.Fatalf("ordered JSON text transaction = %v, want rollback sentinel", err)
	}

	codecRollback := errors.New("rollback codec columns probe")
	err = db.Transaction(func() error {
		row, err := model.Author().Connect(db).AddAllColumns().GetBySeq(1)
		if err != nil {
			return err
		}
		if row == nil {
			return errors.New("seed author row 1 is missing")
		}
		ip := "10.0.0.1"
		row = row.SetIp(&ip)
		row, err = row.SetGzExtend(orm.Value("compressed text"))
		if err != nil {
			return err
		}
		row, err = row.SetBase64Extra(orm.Value("plain"))
		if err != nil {
			return err
		}
		row, err = row.Update()
		if err != nil {
			return err
		}
		stored, err := model.Author().Connect(db).AddAllColumns().GetBySeq(1)
		if err != nil {
			return err
		}
		if stored == nil {
			return errors.New("author row disappeared after codec update")
		}
		gotIP, err := stored.GetIp()
		if err != nil {
			return err
		}
		if gotIP == nil || *gotIP != ip {
			return fmt.Errorf("ip column = %v, want %q", gotIP, ip)
		}
		for _, want := range []struct {
			name string
			get  func() (orm.StyledValue, error)
		}{
			{"gz", stored.GetGzExtend}, {"base64", stored.GetBase64Extra},
		} {
			value, err := want.get()
			if err != nil {
				return err
			}
			got, ok := value.Data()
			if !ok || got != map[string]string{"gz": "compressed text", "base64": "plain"}[want.name] {
				return fmt.Errorf("%s codec column = %#v, want value", want.name, got)
			}
		}
		n, err := model.Author().Connect(db).Ip(&ip).GetCount()
		if err != nil {
			return err
		}
		if n != 1 {
			return fmt.Errorf("ip equality count = %d, want 1", n)
		}
		badIP := "10. 0.0.1"
		if _, err := stored.SetIp(&badIP).Update(); orm.ErrorCode(err) != orm.CodeCodecEncode {
			return fmt.Errorf("ip with embedded whitespace error = %q, want %q", orm.ErrorCode(err), orm.CodeCodecEncode)
		}
		return codecRollback
	}, orm.Retry(0))
	if !errors.Is(err, codecRollback) {
		t.Fatalf("codec columns transaction = %v, want rollback sentinel", err)
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

// TestCoverageModelSaveKeyDispatch checks Save's insert/update choice for missing, zero, and loaded keys.
// Requirements: DSL-109.
func TestCoverageModelSaveKeyDispatch(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	var writes []string
	sentinel := errors.New("DSL-109 request hook stopped the write")
	hooked := db.WithRequestHook(func(request *ir.Request, _ func(any) int, _ []any) error {
		if request.Kind == orm.KindInsert || request.Kind == orm.KindUpdate {
			writes = append(writes, request.Kind)
			return sentinel
		}
		return nil
	})
	assertRejected := func(err error) {
		t.Helper()
		if !errors.Is(err, sentinel) {
			t.Fatalf("Save error = %v, want request-hook sentinel", err)
		}
	}
	if _, err := model.Account().Connect(hooked).SetName("missing").Save(); err != nil {
		assertRejected(err)
	} else {
		t.Fatal("missing-key Save reached execution")
	}
	if !slices.Equal(writes, []string{orm.KindInsert}) {
		t.Fatalf("missing-key Save requests = %v, want insert", writes)
	}

	writes = nil
	if _, err := model.Account().Connect(hooked).SetSeq(0).SetName("zero").Save(); err != nil {
		assertRejected(err)
	} else {
		t.Fatal("zero-key Save reached execution")
	}
	if !slices.Equal(writes, []string{orm.KindUpdate}) {
		t.Fatalf("zero-key Save requests = %v, want update", writes)
	}

	writes = nil
	loaded := must(model.Author().Connect(hooked).RemoveAllColumns().AddColumnSeq().AddColumnReadCount().GetBySeq(1))
	if loaded == nil {
		t.Fatal("seed author 1 is missing")
	}
	if _, err := loaded.SetReadCount(readColumn(t, loaded.GetReadCount)).Save(); err != nil {
		assertRejected(err)
	} else {
		t.Fatal("loaded-key Save reached execution")
	}
	if !slices.Equal(writes, []string{orm.KindUpdate}) {
		t.Fatalf("loaded-key Save requests = %v, want update", writes)
	}
}

// TestCoverageModelArithmeticAttributes checks bound arithmetic on seeded Author.read_count, cleared assignments, and transaction rollback of row state.
// Requirements: PLN-26.
func TestCoverageModelArithmeticAttributes(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	author := func() *model.AuthorModel { return model.Author().Connect(db) }
	before := must(author().AddAllColumns().GetBySeq(1))
	beforeReadCount := readColumn(t, before.GetReadCount)
	beforeUpdatedTs := readColumn(t, before.GetUpdatedTs)
	if beforeReadCount != 1 {
		t.Fatalf("seed author 1 read_count = %d, want 1", beforeReadCount)
	}
	boom := errors.New("PLN-26 rollback sentinel")
	recorder := testcase.NewEventRecorder[orm.StatementEvent]()
	err := db.Transaction(func() error {
		loaded, err := author().AddAllColumns().GetBySeq(1)
		if err != nil {
			return err
		}
		if loaded == nil {
			return errors.New("seed author 1 is missing")
		}
		if _, err := loaded.SetReadCount(1).Update(); err != nil {
			return err
		}
		unsubscribe, err := db.Subscribe(recorder.Record)
		if err != nil {
			return err
		}
		defer unsubscribe()
		loaded, err = author().AddAllColumns().GetBySeq(1)
		if err != nil {
			return err
		}
		if loaded == nil {
			return errors.New("seed author 1 disappeared after setting read_count")
		}
		if _, err := loaded.PlusReadCount(7).Update(); err != nil {
			return err
		}
		updated, err := author().AddAllColumns().GetBySeq(1)
		if err != nil {
			return err
		}
		if updated == nil {
			return errors.New("seed author 1 disappeared after plus")
		}
		plusValue, err := updated.GetReadCount()
		if err != nil {
			return err
		}
		if plusValue != 8 {
			return fmt.Errorf("read_count after plus = %d, want 8", plusValue)
		}
		if _, err := loaded.Update(); err != nil {
			return err
		}
		updates := 0
		foundPlus := false
		for _, event := range recorder.Events() {
			if event.Kind != orm.KindUpdate || !slices.Contains(event.Tables, "author") {
				continue
			}
			updates++
			for _, bind := range event.Binds {
				foundPlus = foundPlus || fmt.Sprint(bind) == "7"
			}
		}
		if updates != 1 {
			return fmt.Errorf("author updates after repeating a completed write = %d, want 1", updates)
		}
		if !foundPlus {
			return fmt.Errorf("plus amount 7 is absent from update binds: %#v", recorder.Events())
		}
		current, err := author().AddAllColumns().GetBySeq(1)
		if err != nil {
			return err
		}
		if current == nil {
			return errors.New("seed author 1 disappeared before minus")
		}
		if _, err := current.MinusReadCount(9).Update(); err != nil {
			return err
		}
		updated, err = author().AddAllColumns().GetBySeq(1)
		if err != nil {
			return err
		}
		if updated == nil {
			return errors.New("seed author 1 disappeared after minus")
		}
		minusValue, err := updated.GetReadCount()
		if err != nil {
			return err
		}
		if minusValue != 0 {
			return fmt.Errorf("read_count after minus = %d, want zero clamp", minusValue)
		}
		foundMinus := false
		for _, event := range recorder.Events() {
			for _, bind := range event.Binds {
				foundMinus = foundMinus || fmt.Sprint(bind) == "9"
			}
		}
		if !foundMinus {
			return fmt.Errorf("minus amount 9 is absent from update binds: %#v", recorder.Events())
		}
		return boom
	}, orm.Retry(0))
	if !errors.Is(err, boom) {
		t.Fatalf("transaction error = %v, want the sentinel", err)
	}
	after := must(author().AddAllColumns().GetBySeq(1))
	if got := readColumn(t, after.GetReadCount); got != beforeReadCount {
		t.Fatalf("read_count after rollback = %d, want %d", got, beforeReadCount)
	}
	if got := readColumn(t, after.GetUpdatedTs); fmt.Sprint(got) != fmt.Sprint(beforeUpdatedTs) {
		t.Fatalf("updated_ts after rollback = %v, want %v", got, beforeUpdatedTs)
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
