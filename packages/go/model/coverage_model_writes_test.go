//go:build featurecoverage

package model_test

import (
	"encoding/json/jsontext"
	"errors"
	"fmt"
	"slices"
	"testing"

	orderedjson "github.com/polyspec/ordered-json/packages/go"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// writeTenant is the tenant_id of composite_account that create_parts writes.
const writeTenant = 990002

// TestCoverageModelWriteCycle checks the ordered JSON text and the codec columns of a write. The model_writes
// recipe asserts the CRUD behaviour of a write, so it is not tested here again.
// Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26.
func TestCoverageModelWriteCycle(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)

	const jsonText = `{"b":1,"a":[],"c":{},"n":1.50}`
	rollback := errors.New("rollback ordered JSON text probe")
	err := db.Transaction(func() error {
		value, err := storeOrderedJSON(db, jsonText)
		if err != nil {
			return err
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
		row, err := loadSeedAuthor(db, "seed author row 1 is missing")
		if err != nil {
			return err
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
		stored, err := updateAndReloadAuthor(row, db, "author row disappeared after codec update")
		if err != nil {
			return err
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
		n, err := model.Author().Connect(db).Ip(ip).GetCount()
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

}

// TestCoverageModelOrderedJsonRepeatedMemberName stores a jsontext value whose object repeats a member name,
// and reads the stored text back, in a transaction that is rolled back. A repeated name keeps both values
// in place (DIA-26), so the text is compared with value.Raw(); orderedjson.Stringify compacts the parsed
// member map and would hide the repeated name.
// Requirements: DIA-26, COD-15.
func TestCoverageModelOrderedJsonRepeatedMemberName(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	const jsonText = `{"a":1,"b":2,"a":3}`
	rollback := errors.New("rollback ordered JSON repeated member probe")
	err := db.Transaction(func() error {
		value, err := storeOrderedJSON(db, jsonText)
		if err != nil {
			return err
		}
		if actual := value.Raw(); actual != jsonText {
			return fmt.Errorf("ordered JSON text = %s, want %s", actual, jsonText)
		}
		return rollback
	}, orm.Retry(0))
	if !errors.Is(err, rollback) {
		t.Fatalf("ordered JSON repeated member transaction = %v, want rollback sentinel", err)
	}
}

// storeOrderedJSON writes jsonText to the json_setting column of the seed author and returns the ordered JSON value it reads
// back.
func storeOrderedJSON(db *orm.DB, jsonText string) (*orderedjson.Value, error) {
	row, err := loadSeedAuthor(db, "seed author row 1 is missing")
	if err != nil {
		return nil, err
	}
	row, err = row.SetJsonSetting(orm.Value(jsontext.Value(jsonText)))
	if err != nil {
		return nil, err
	}
	stored, err := updateAndReloadAuthor(row, db, "seed author row 1 disappeared after ordered JSON update")
	if err != nil {
		return nil, err
	}
	styled, err := stored.GetJsonSetting()
	if err != nil {
		return nil, err
	}
	data, ok := styled.Data()
	if !ok {
		return nil, errors.New("ordered JSON text read back as SQL NULL")
	}
	value, ok := data.(*orderedjson.Value)
	if !ok {
		return nil, fmt.Errorf("ordered JSON value has type %T", data)
	}
	return value, nil
}

func loadSeedAuthor(db *orm.DB, missingMessage string) (*model.AuthorModel, error) {
	row, err := model.Author().Connect(db).AddAllColumns().GetBySeq(1)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, errors.New(missingMessage)
	}
	return row, nil
}

func updateAndReloadAuthor(row *model.AuthorModel, db *orm.DB, missingMessage string) (*model.AuthorModel, error) {
	if _, err := row.Update(); err != nil {
		return nil, err
	}
	stored, err := model.Author().Connect(db).AddAllColumns().GetBySeq(1)
	if err != nil {
		return nil, err
	}
	if stored == nil {
		return nil, errors.New(missingMessage)
	}
	return stored, nil
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
