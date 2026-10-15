//go:build featurecoverage

package orm_test

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/engine"
	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// plannerStatement는 compile된 plan step 하나의 role, SQL, bind slot, table이다.
type plannerStatement struct {
	Role   string        `json:"role"`
	SQL    string        `json:"sql"`
	Slots  []plannerSlot `json:"slots"`
	Tables []string      `json:"tables"`
}

// plannerSlot은 bind slot 하나의 출처와 type이다. param slot은 request 값의
// 번호를, parent slot은 key의 type을, 나머지 slot은 type을 싣는다.
type plannerSlot struct {
	From  string `json:"from"`
	Param *int   `json:"param,omitempty"`
	Type  string `json:"type,omitempty"`
	// Precision is the fraction digits of a datetime or time slot.
	Precision *int     `json:"precision,omitempty"`
	KeyTypes  []string `json:"key_types,omitempty"`
}

// compilePlannerCase는 planner fixture case의 input에 그 case의 schema 문서의
// manifest_hash를 더해 각 dialect의 engine으로 compile하고, 기대한
// statement나 error code와 비교한다.
func compilePlannerCase(t *testing.T, id string) {
	t.Helper()
	c := featureFixture(t, "planner", id, "compile")
	if c.Schema == "" {
		t.Fatalf("case %s names no schema; give it the repository path of its dbspec document", id)
	}
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", filepath.FromSlash(c.Schema)))
	if err != nil {
		t.Fatal(err)
	}
	var input map[string]any
	decodeFixture(t, c.Input, &input)
	if _, ok := input["manifest_hash"]; ok {
		t.Fatalf("case %s input already holds manifest_hash", id)
	}
	input["manifest_hash"] = m.ManifestHash
	request, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var expected struct {
		Error    string             `json:"error"`
		MySQL    []plannerStatement `json:"mysql"`
		Postgres []plannerStatement `json:"postgres"`
		SQLite   []plannerStatement `json:"sqlite"`
	}
	decodeFixture(t, c.Expected, &expected)
	for dialect, want := range map[string][]plannerStatement{"mysql": expected.MySQL, "postgres": expected.Postgres, "sqlite": expected.SQLite} {
		e, err := engine.New(m, dialect)
		if err != nil {
			t.Fatal(err)
		}
		out, err := e.Compile(request)
		if expected.Error != "" {
			if want != nil || err == nil || orm.ErrorCode(err) != expected.Error {
				t.Fatalf("%s: compile = %s, %v; want %s", dialect, out, err, expected.Error)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", dialect, err)
		}
		var compiled plan.Plan
		if err := json.Unmarshal(out, &compiled); err != nil {
			t.Fatal(err)
		}
		got := []plannerStatement{}
		for _, step := range compiled.Steps {
			slots := []plannerSlot{}
			for _, slot := range step.BindSlots {
				s := plannerSlot{From: slot.From}
				switch slot.From {
				case "param":
					s.Param, s.Type = &slot.Param, slot.ColType
				case "parent":
					s.KeyTypes = slot.KeyTypes
				default:
					s.Type = slot.ColType
				}
				if slot.ColType == "datetime" || slot.ColType == "time" {
					precision := slot.Precision
					s.Precision = &precision
				}
				slots = append(slots, s)
			}
			got = append(got, plannerStatement{Role: step.Role, SQL: step.SQL, Slots: slots, Tables: step.Tables})
		}
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(want)
		if len(want) == 0 || string(gotJSON) != string(wantJSON) {
			t.Fatalf("%s statements:\n got %s\nwant %s", dialect, gotJSON, wantJSON)
		}
	}
}

// TestCoveragePlannerStatement는 조건, 정렬, limit이 있는 row select를 compile한다.
func TestCoveragePlannerStatement(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_statement")
}

// TestCoveragePlannerCount는 count를 compile한다.
func TestCoveragePlannerCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_count")
}

// TestCoveragePlannerRejectsUnknownColumn는 없는 column 조건이 COLUMN_UNKNOWN인지 확인한다.
func TestCoveragePlannerRejectsUnknownColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_unknown_column")
}

// TestCoveragePlannerRestore는 soft delete한 행을 primary key로 되돌리는 restore를 compile한다.
func TestCoveragePlannerRestore(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore")
}

// TestCoveragePlannerRestoreRejectsNonKey는 key가 아닌 column의 restore가 IR_INVALID인지 확인한다.
func TestCoveragePlannerRestoreRejectsNonKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore_rejects_non_key")
}

// TestCoveragePlannerRestoreKeyFromSet compiles a restore whose set names the primary key, which becomes the condition.
func TestCoveragePlannerRestoreKeyFromSet(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore_key_from_set")
}

// TestCoveragePlannerRestoreExtraCondition compiles a restore whose where narrows the key of its set.
func TestCoveragePlannerRestoreExtraCondition(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore_extra_condition")
}

// TestCoveragePlannerRestorePrimaryKeyFirst compiles a restore whose set covers the primary key and a unique key.
func TestCoveragePlannerRestorePrimaryKeyFirst(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore_primary_key_first")
}

// TestCoveragePlannerRestoreFirstUniqueByName compiles a restore whose set covers two unique keys.
func TestCoveragePlannerRestoreFirstUniqueByName(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore_first_unique_by_name")
}

// TestCoveragePlannerTables는 subquery, join, relation이 있는 select의 step마다
// statement가 이름으로 쓰는 table을 확인한다.
func TestCoveragePlannerTables(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_tables")
}

// TestCoveragePlannerBindTypesSelect는 select의 조건 slot이 column, 함수, 상대 시각 함수의 type을 싣는지 확인한다.
func TestCoveragePlannerBindTypesSelect(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_select")
}

// TestCoveragePlannerBindTypesUpdate는 update의 할당, AES, blind index, config, optimistic slot의 type을 확인한다.
func TestCoveragePlannerBindTypesUpdate(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_update")
}

// TestCoveragePlannerBindTypesInsert는 insert의 값, AES, blind index, config, now slot의 type을 확인한다.
func TestCoveragePlannerBindTypesInsert(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_insert")
}

// TestCoveragePlannerParentKeyTypes는 composite key relation의 parent slot이 key type을 싣는지 확인한다.
func TestCoveragePlannerParentKeyTypes(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_parent_key_types")
}

// TestCoveragePlannerNotGroup는 select의 NOT group이 그 조건을 괄호와 함께 부정하는지 확인한다.
func TestCoveragePlannerNotGroup(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_not_group")
}

// TestCoveragePlannerRejectsTopNot는 top-level where group의 not이 IR_INVALID인지 확인한다.
func TestCoveragePlannerRejectsTopNot(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_top_not")
}

// TestCoveragePlannerRejectsTopGroupConn는 top-level where group의 conn이 IR_INVALID인지 확인한다.
func TestCoveragePlannerRejectsTopGroupConn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_top_group_conn")
}

// TestCoveragePlannerRejectsFirstItemConn는 group 첫 item의 conn and가 IR_INVALID인지 확인한다.
func TestCoveragePlannerRejectsFirstItemConn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_first_item_conn")
}

// TestCoveragePlannerColumnRefs는 join path와 subquery 안의 "^" ref를 쓰는 column 비교를 compile한다.
func TestCoveragePlannerColumnRefs(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_column_refs")
}

// TestCoveragePlannerRejectsRefUnknownColumn는 count가 실행하지 않는 relation의 ref도 검증해 없는 column을
// COLUMN_UNKNOWN으로 거절하는지 확인한다.
func TestCoveragePlannerRejectsRefUnknownColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_ref_unknown_column")
}

// TestCoveragePlannerRejectsOuterRefOutsideSubquery는 subquery 밖의 "^" ref가 IR_INVALID인지 확인한다.
func TestCoveragePlannerRejectsOuterRefOutsideSubquery(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_outer_ref_outside_subquery")
}

// TestCoveragePlannerRefPathAbsent는 path 없는 ref가 statement의 root를 가리키는지 확인한다.
func TestCoveragePlannerRefPathAbsent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_ref_path_absent")
}

// TestCoveragePlannerRejectsUnjoinedRef는 statement에 join되지 않은 path의 ref가 ENTITY_NOT_JOINED인지 확인한다.
func TestCoveragePlannerRejectsUnjoinedRef(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_unjoined_ref")
}

// TestCoveragePlannerGroupByCount는 group_by가 있는 count가 group 수를 세는지 확인한다.
func TestCoveragePlannerGroupByCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_by_count")
}

// TestCoveragePlannerGroupCountOrderColumn는 group_count가 group column으로 정렬되는지 확인한다.
func TestCoveragePlannerGroupCountOrderColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_count_order_column")
}

// TestCoveragePlannerGroupCountOrderColumnFunction는 group_count가 group column의 column function으로 정렬되는지 확인한다.
func TestCoveragePlannerGroupCountOrderColumnFunction(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_count_order_column_function")
}

// TestCoveragePlannerGroupCountOrderRandom는 group_count가 random으로 정렬되는지 확인한다.
func TestCoveragePlannerGroupCountOrderRandom(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_count_order_random")
}

// TestCoveragePlannerRejectsGroupByAll는 all의 group_by가 IR_INVALID인지 확인한다.
func TestCoveragePlannerRejectsGroupByAll(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_all")
}

// TestCoveragePlannerRejectsGroupBySum는 sum의 group_by가 IR_INVALID인지 확인한다.
func TestCoveragePlannerRejectsGroupBySum(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_sum")
}

// TestCoveragePlannerRejectsGroupByJoin는 join query의 group_by가 IR_INVALID인지 확인한다.
func TestCoveragePlannerRejectsGroupByJoin(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_join")
}

// TestCoveragePlannerRejectsGroupBySubquery는 subquery의 group_by가 IR_INVALID인지 확인한다.
func TestCoveragePlannerRejectsGroupBySubquery(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_subquery")
}

// TestCoveragePlannerRejectsGroupOrderNonGroupColumn는 group이 아닌 column의 group 정렬이 IR_INVALID인지 확인한다.
func TestCoveragePlannerRejectsGroupOrderNonGroupColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_order_non_group_column")
}

// TestCoveragePlannerRejectsNullableKeyBy는 nullable key_by column이 IR_INVALID인지 확인한다.
func TestCoveragePlannerRejectsNullableKeyBy(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_nullable_key_by")
}

// TestCoveragePlannerKeyByEmptyIsAbsent는 빈 key_by가 없는 key_by처럼 읽히는지 확인한다.
func TestCoveragePlannerKeyByEmptyIsAbsent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_key_by_empty_is_absent")
}

// TestCoveragePlannerInsertByValue는 insert by value case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerInsertByValue(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_insert_by_value")
}

// TestCoveragePlannerInsertOnDuplicatePlus는 insert on duplicate plus case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerInsertOnDuplicatePlus(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_insert_on_duplicate_plus")
}

// TestCoveragePlannerRejectsInsertSetPlus는 rejects insert set plus case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsInsertSetPlus(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_insert_set_plus")
}

// TestCoveragePlannerRejectsInsertSetMinus는 rejects insert set minus case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsInsertSetMinus(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_insert_set_minus")
}

// TestCoveragePlannerIpEqColIp는 ip eq col ip case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerIpEqColIp(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_ip_eq_col_ip")
}

// TestCoveragePlannerRejectsBoolGtCol는 rejects bool gt col case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsBoolGtCol(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_bool_gt_col")
}

// TestCoveragePlannerRejectsIpGtCol는 rejects ip gt col case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsIpGtCol(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_ip_gt_col")
}

// TestCoveragePlannerRejectsAesEqCol는 rejects aes eq col case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsAesEqCol(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_aes_eq_col")
}

// TestCoveragePlannerColPairIntegers는 col pair integers case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerColPairIntegers(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_col_pair_integers")
}

// TestCoveragePlannerRejectsColPairIntegerVarchar는 rejects col pair integer varchar case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsColPairIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_col_pair_integer_varchar")
}

// TestCoveragePlannerRejectsInSubqueryIntegerVarchar는 rejects in subquery integer varchar case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsInSubqueryIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_in_subquery_integer_varchar")
}

// TestCoveragePlannerRejectsJoinIntegerVarchar는 rejects join integer varchar case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsJoinIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_join_integer_varchar")
}

// TestCoveragePlannerRejectsRelationIntegerVarchar는 rejects relation integer varchar case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsRelationIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_relation_integer_varchar")
}

// TestCoveragePlannerRejectsUpsertPrimaryAndUniqueKey는 rejects upsert primary and unique key case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsUpsertPrimaryAndUniqueKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_upsert_primary_and_unique_key")
}

// TestCoveragePlannerRejectsUpsertUniqueKeyNotAssigned는 rejects upsert unique key not assigned case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsUpsertUniqueKeyNotAssigned(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_upsert_unique_key_not_assigned")
}

// TestCoveragePlannerRejectsUpsertWithoutAKey는 rejects upsert without a key case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsUpsertWithoutAKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_upsert_without_a_key")
}

// TestCoveragePlannerOrderNullableColumn는 order nullable column case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerOrderNullableColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_column")
}

// TestCoveragePlannerOrderNotNullColumn는 order not null column case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerOrderNotNullColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_not_null_column")
}

// TestCoveragePlannerOrderNullableColumnFunction는 order nullable column function case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerOrderNullableColumnFunction(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_column_function")
}

// TestCoveragePlannerOrderNullableGroupCount는 order nullable group count case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerOrderNullableGroupCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_group_count")
}

// TestCoveragePlannerOrderNullableLimitPerParent는 order nullable limit per parent case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerOrderNullableLimitPerParent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_limit_per_parent")
}

// TestCoveragePlannerScalarColumnSubquery는 scalar column subquery case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerScalarColumnSubquery(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_scalar_column_subquery")
}

// TestCoveragePlannerRejectsScalarColumnSubqueryWithoutLimit는 rejects scalar column subquery without limit case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsScalarColumnSubqueryWithoutLimit(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_scalar_column_subquery_without_limit")
}

// TestCoveragePlannerRejectsScalarColumnSubqueryWithoutKeyOrder는 rejects scalar column subquery without key order case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsScalarColumnSubqueryWithoutKeyOrder(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_scalar_column_subquery_without_key_order")
}

// TestCoveragePlannerRejectsInSubqueryLimit는 rejects in subquery limit case가 기대한 대로 compile되는지 확인한다.
func TestCoveragePlannerRejectsInSubqueryLimit(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_in_subquery_limit")
}
