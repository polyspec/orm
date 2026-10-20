//go:build featurecoverage

package orm_test

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/engine"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// plannerStatement is the role, SQL, bind slot, and table of one compiled plan step.
type plannerStatement struct {
	Role   string        `json:"role"`
	SQL    string        `json:"sql"`
	Slots  []plannerSlot `json:"slots"`
	Tables []string      `json:"tables"`
}

// plannerSlot is the source and type of one bind slot. A param slot
// carries the request value's number, a parent slot carries the key's type, and the other slots carry a type.
type plannerSlot struct {
	From  string `json:"from"`
	Param *int   `json:"param,omitempty"`
	Type  string `json:"type,omitempty"`
	// Precision is the fraction digits of a datetime or time slot.
	Precision *int `json:"precision,omitempty"`
	// Length is the n of a varchar(n) param slot.
	Length *int `json:"length,omitempty"`
	// NotNull marks a param slot that assigns a non-null column.
	NotNull  bool     `json:"not_null,omitempty"`
	KeyTypes []string `json:"key_types,omitempty"`
}

// compilePlannerCase adds the manifest_hash of that case's schema document to the input of a planner fixture case
// and compiles it with each dialect's engine, then compares the result with the expected
// statement or error code.
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
				s.NotNull = slot.NotNull
				if slot.From == "param" && slot.ColType == "varchar" {
					length := slot.Length
					s.Length = &length
				}
				slots = append(slots, s)
			}
			got = append(got, plannerStatement{Role: step.Role, SQL: step.SQL, Slots: slots, Tables: step.Tables})
		}
		checkStatementsJSON(t, dialect, got, want, len(want))
	}
}

// TestCoveragePlannerStatement compiles a row select with a condition, ordering, and limit.
func TestCoveragePlannerStatement(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_statement")
}

// TestCoveragePlannerCount compiles a count.
func TestCoveragePlannerCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_count")
}

// TestCoveragePlannerContainsBinaryCollation checks that contains_binary compiles on MySQL to a LIKE under the binary collation.
func TestCoveragePlannerContainsBinaryCollation(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_contains_binary_collation")
}

// TestCoveragePlannerContainsAsciiFold checks that contains compiles on MySQL to a 26-level REPLACE that folds only ASCII letters.
func TestCoveragePlannerContainsAsciiFold(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_contains_ascii_fold")
}

// TestCoveragePlannerRejectsUnknownColumn checks that a condition on a missing column is COLUMN_UNKNOWN.
func TestCoveragePlannerRejectsUnknownColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_unknown_column")
}

// TestCoveragePlannerRestore compiles a restore that brings back a soft-deleted row by primary key.
func TestCoveragePlannerRestore(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore")
}

// TestCoveragePlannerRestoreRejectsNonKey checks that a restore on a non-key column is IR_INVALID.
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

// TestCoveragePlannerTables checks, for each step of a select with a subquery, join, and relation,
// the table that the statement uses by name.
func TestCoveragePlannerTables(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_tables")
}

// TestCoveragePlannerBindTypesSelect checks that select condition slots carry the types of columns, functions, and relative time functions.
func TestCoveragePlannerBindTypesSelect(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_select")
}

// TestCoveragePlannerBindTypesUpdate checks the types of the update assignment, AES, blind index, config, and optimistic slots.
func TestCoveragePlannerBindTypesUpdate(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_update")
}

// TestCoveragePlannerBindTypesInsert checks the types of the insert values, AES, blind index, config, and now slots.
func TestCoveragePlannerBindTypesInsert(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_insert")
}

// TestCoveragePlannerTimeSelect reads a time(p) column as text with p digits and binds the compared value as text.
func TestCoveragePlannerTimeSelect(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_time_select")
}

// TestCoveragePlannerTimeInsert binds time(p) and datetime(p) values at the precision of their slot.
func TestCoveragePlannerTimeInsert(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_time_insert")
}

// TestCoveragePlannerUuidSelect reads a PostgreSQL uuid column as text and casts the compared value from text.
func TestCoveragePlannerUuidSelect(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_uuid_select")
}

// TestCoveragePlannerUuidInsert casts a PostgreSQL uuid value from text and writes it.
func TestCoveragePlannerUuidInsert(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_uuid_insert")
}

// TestCoveragePlannerClockCompare binds the value function's clock with six digits, and on SQLite compares datetime(p < 6)
// by extending the column to six digits.
func TestCoveragePlannerClockCompare(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_clock_compare")
}

// TestCoveragePlannerClockInsert checks that on PostgreSQL and SQLite, the default now column the insert omitted
// binds a now slot truncated to the column's fractional digits.
func TestCoveragePlannerClockInsert(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_clock_insert")
}

// TestCoveragePlannerParentKeyTypes checks that the parent slot of a composite key relation carries the key types.
func TestCoveragePlannerParentKeyTypes(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_parent_key_types")
}

// TestCoveragePlannerNotGroup checks that a NOT group in select negates its condition together with the parentheses.
func TestCoveragePlannerNotGroup(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_not_group")
}

// TestCoveragePlannerRejectsTopNot checks that not in a top-level where group is IR_INVALID.
func TestCoveragePlannerRejectsTopNot(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_top_not")
}

// TestCoveragePlannerRejectsTopGroupConn checks that conn in a top-level where group is IR_INVALID.
func TestCoveragePlannerRejectsTopGroupConn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_top_group_conn")
}

// TestCoveragePlannerRejectsFirstItemConn checks that the conn and on the first item of a group is IR_INVALID.
func TestCoveragePlannerRejectsFirstItemConn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_first_item_conn")
}

// TestCoveragePlannerColumnRefs compiles column comparisons that use "^" refs in a join path and in a subquery.
func TestCoveragePlannerColumnRefs(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_column_refs")
}

// TestCoveragePlannerRejectsRefUnknownColumn also validates refs of relations that count does not run, and rejects a missing column
// with COLUMN_UNKNOWN.
func TestCoveragePlannerRejectsRefUnknownColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_ref_unknown_column")
}

// TestCoveragePlannerRejectsOuterRefOutsideSubquery checks that a "^" ref outside a subquery is IR_INVALID.
func TestCoveragePlannerRejectsOuterRefOutsideSubquery(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_outer_ref_outside_subquery")
}

// TestCoveragePlannerRefPathAbsent checks that a ref without a path points to the statement's root.
func TestCoveragePlannerRefPathAbsent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_ref_path_absent")
}

// TestCoveragePlannerRejectsUnjoinedRef checks that a ref to a path not joined in the statement is ENTITY_NOT_JOINED.
func TestCoveragePlannerRejectsUnjoinedRef(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_unjoined_ref")
}

// TestCoveragePlannerGroupByCount checks that a count with group_by counts the groups.
func TestCoveragePlannerGroupByCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_by_count")
}

// TestCoveragePlannerGroupCountOrderColumn checks that group_count is ordered by the group column.
func TestCoveragePlannerGroupCountOrderColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_count_order_column")
}

// TestCoveragePlannerGroupCountOrderColumnFunction checks that group_count is ordered by a column function of the group column.
func TestCoveragePlannerGroupCountOrderColumnFunction(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_count_order_column_function")
}

// TestCoveragePlannerGroupCountOrderRandom checks that group_count is ordered randomly.
func TestCoveragePlannerGroupCountOrderRandom(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_count_order_random")
}

// TestCoveragePlannerRejectsGroupByAll checks that group_by on all is IR_INVALID.
func TestCoveragePlannerRejectsGroupByAll(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_all")
}

// TestCoveragePlannerRejectsGroupBySum checks that group_by on sum is IR_INVALID.
func TestCoveragePlannerRejectsGroupBySum(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_sum")
}

// TestCoveragePlannerRejectsGroupByJoin checks that group_by on a join query is IR_INVALID.
func TestCoveragePlannerRejectsGroupByJoin(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_join")
}

// TestCoveragePlannerRejectsGroupBySubquery checks that group_by on a subquery is IR_INVALID.
func TestCoveragePlannerRejectsGroupBySubquery(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_subquery")
}

// TestCoveragePlannerRejectsGroupOrderNonGroupColumn checks that ordering a group by a non-group column is IR_INVALID.
func TestCoveragePlannerRejectsGroupOrderNonGroupColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_order_non_group_column")
}

// TestCoveragePlannerRejectsNullableKeyBy checks that a nullable key_by column is IR_INVALID.
func TestCoveragePlannerRejectsNullableKeyBy(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_nullable_key_by")
}

// TestCoveragePlannerKeyByEmptyIsAbsent checks that an empty key_by reads as an absent key_by.
func TestCoveragePlannerKeyByEmptyIsAbsent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_key_by_empty_is_absent")
}

// TestCoveragePlannerInsertByValue checks that the insert by value case compiles as expected.
func TestCoveragePlannerInsertByValue(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_insert_by_value")
}

// TestCoveragePlannerInsertOnDuplicatePlus checks that the insert on duplicate plus case compiles as expected.
func TestCoveragePlannerInsertOnDuplicatePlus(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_insert_on_duplicate_plus")
}

// TestCoveragePlannerRejectsInsertSetPlus checks that the rejects insert set plus case compiles as expected.
func TestCoveragePlannerRejectsInsertSetPlus(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_insert_set_plus")
}

// TestCoveragePlannerRejectsInsertSetMinus checks that the rejects insert set minus case compiles as expected.
func TestCoveragePlannerRejectsInsertSetMinus(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_insert_set_minus")
}

// TestCoveragePlannerIpEqColIp checks that the ip eq col ip case compiles as expected.
func TestCoveragePlannerIpEqColIp(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_ip_eq_col_ip")
}

// TestCoveragePlannerRejectsBoolGtCol checks that the rejects bool gt col case compiles as expected.
func TestCoveragePlannerRejectsBoolGtCol(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_bool_gt_col")
}

// TestCoveragePlannerRejectsIpGtCol checks that the rejects ip gt col case compiles as expected.
func TestCoveragePlannerRejectsIpGtCol(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_ip_gt_col")
}

// TestCoveragePlannerRejectsAesEqCol checks that the rejects aes eq col case compiles as expected.
func TestCoveragePlannerRejectsAesEqCol(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_aes_eq_col")
}

// TestCoveragePlannerColPairIntegers checks that the col pair integers case compiles as expected.
func TestCoveragePlannerColPairIntegers(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_col_pair_integers")
}

// TestCoveragePlannerRejectsColPairIntegerVarchar checks that the rejects col pair integer varchar case compiles as expected.
func TestCoveragePlannerRejectsColPairIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_col_pair_integer_varchar")
}

// TestCoveragePlannerRejectsInSubqueryIntegerVarchar checks that the rejects in subquery integer varchar case compiles as expected.
func TestCoveragePlannerRejectsInSubqueryIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_in_subquery_integer_varchar")
}

// TestCoveragePlannerRejectsJoinIntegerVarchar checks that the rejects join integer varchar case compiles as expected.
func TestCoveragePlannerRejectsJoinIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_join_integer_varchar")
}

// TestCoveragePlannerRejectsRelationIntegerVarchar checks that the rejects relation integer varchar case compiles as expected.
func TestCoveragePlannerRejectsRelationIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_relation_integer_varchar")
}

// TestCoveragePlannerRejectsUpsertPrimaryAndUniqueKey checks that the rejects upsert primary and unique key case compiles as expected.
func TestCoveragePlannerRejectsUpsertPrimaryAndUniqueKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_upsert_primary_and_unique_key")
}

// TestCoveragePlannerRejectsUpsertUniqueKeyNotAssigned checks that the rejects upsert unique key not assigned case compiles as expected.
func TestCoveragePlannerRejectsUpsertUniqueKeyNotAssigned(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_upsert_unique_key_not_assigned")
}

// TestCoveragePlannerRejectsUpsertWithoutAKey checks that the rejects upsert without a key case compiles as expected.
func TestCoveragePlannerRejectsUpsertWithoutAKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_upsert_without_a_key")
}

// TestCoveragePlannerOrderNullableColumn checks that the order nullable column case compiles as expected.
func TestCoveragePlannerOrderNullableColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_column")
}

// TestCoveragePlannerOrderNotNullColumn checks that the order not null column case compiles as expected.
func TestCoveragePlannerOrderNotNullColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_not_null_column")
}

// TestCoveragePlannerOrderNullableColumnFunction checks that the order nullable column function case compiles as expected.
func TestCoveragePlannerOrderNullableColumnFunction(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_column_function")
}

// TestCoveragePlannerOrderNullableGroupCount checks that the order nullable group count case compiles as expected.
func TestCoveragePlannerOrderNullableGroupCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_group_count")
}

// TestCoveragePlannerOrderNullableLimitPerParent checks that the order nullable limit per parent case compiles as expected.
func TestCoveragePlannerOrderNullableLimitPerParent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_limit_per_parent")
}

// TestCoveragePlannerScalarColumnSubquery checks that the scalar column subquery case compiles as expected.
func TestCoveragePlannerScalarColumnSubquery(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_scalar_column_subquery")
}

// TestCoveragePlannerRejectsScalarColumnSubqueryWithoutLimit checks that the rejects scalar column subquery without limit case compiles as expected.
func TestCoveragePlannerRejectsScalarColumnSubqueryWithoutLimit(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_scalar_column_subquery_without_limit")
}

// TestCoveragePlannerRejectsScalarColumnSubqueryWithoutKeyOrder checks that the rejects scalar column subquery without key order case compiles as expected.
func TestCoveragePlannerRejectsScalarColumnSubqueryWithoutKeyOrder(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_scalar_column_subquery_without_key_order")
}

// TestCoveragePlannerRejectsInSubqueryLimit checks that the rejects in subquery limit case compiles as expected.
func TestCoveragePlannerRejectsInSubqueryLimit(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_in_subquery_limit")
}

// TestCoveragePlannerJoinInnerSoftDelete checks that the join inner soft delete case compiles as expected.
func TestCoveragePlannerJoinInnerSoftDelete(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_join_inner_soft_delete")
}

// TestCoveragePlannerJoinLeftSoftDelete checks that the join left soft delete case compiles as expected.
func TestCoveragePlannerJoinLeftSoftDelete(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_join_left_soft_delete")
}

// TestCoveragePlannerJoinOnSoftDelete checks that the join on soft delete case compiles as expected.
func TestCoveragePlannerJoinOnSoftDelete(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_join_on_soft_delete")
}

// TestCoveragePlannerForceIndex compiles an index hint: MySQL FORCE INDEX, SQLite INDEXED BY, and no hint on PostgreSQL.
func TestCoveragePlannerForceIndex(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_force_index")
}

// TestCoveragePlannerValueFunctionToday compiles today(): MySQL CURDATE(), PostgreSQL CURRENT_DATE, and on SQLite the date of the bound client clock.
func TestCoveragePlannerValueFunctionToday(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_value_function_today")
}

// TestCoveragePlannerColumnFunctionDate compiles the date() column function: MySQL DATE(c), PostgreSQL CAST(c AS date), SQLite date(c).
func TestCoveragePlannerColumnFunctionDate(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_column_function_date")
}

// TestCoveragePlannerRejectsColumnFunctionOnVarchar checks that a column function on a column type it does not list is OPERATOR_NOT_ALLOWED.
func TestCoveragePlannerRejectsColumnFunctionOnVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_column_function_on_varchar")
}

// TestCoveragePlannerRejectsStyledColumnEquality checks that a styled column takes no comparison other than is null and is not null.
func TestCoveragePlannerRejectsStyledColumnEquality(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_styled_column_equality")
}

// TestCoveragePlannerStyledColumnIsNull compiles is null on a styled column.
func TestCoveragePlannerStyledColumnIsNull(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_styled_column_is_null")
}

// paramUseOut is one use of a parameter as planner.json writes it: the slot's logical type and, for a
// column slot, the column with its length, precision, scale and nullability.
type paramUseOut struct {
	Type      string  `json:"type"`
	Assign    bool    `json:"assign,omitempty"`
	Column    *string `json:"column,omitempty"`
	Length    *int    `json:"length,omitempty"`
	Null      *bool   `json:"null,omitempty"`
	Precision *int    `json:"precision,omitempty"`
	Scale     *int    `json:"scale,omitempty"`
}

// paramUsesCase validates the request of a param_uses case of planner.json and compares
// ir.ParamUses with the expected uses of each parameter.
func paramUsesCase(t *testing.T, id string) {
	t.Helper()
	c := featureFixture(t, "planner", id, "param_uses")
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", filepath.FromSlash(c.Schema)))
	if err != nil {
		t.Fatal(err)
	}
	var request ir.Request
	decodeFixture(t, c.Input, &request)
	request.ManifestHash = m.ManifestHash
	if err := ir.Validate(m, &request); err != nil {
		t.Fatal(err)
	}
	got := [][]paramUseOut{}
	for _, uses := range ir.ParamUses(m, &request) {
		list := []paramUseOut{}
		for _, u := range uses {
			out := paramUseOut{Type: u.Type, Assign: u.Assign}
			if f := u.Column; f != nil {
				out.Column, out.Length, out.Null, out.Precision, out.Scale = &f.Name, &f.Length, &f.Null, &f.Precision, &f.Scale
			}
			list = append(list, out)
		}
		got = append(got, list)
	}
	var expected struct {
		Uses [][]paramUseOut `json:"uses"`
	}
	decodeFixture(t, c.Expected, &expected)
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(expected.Uses)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("param uses:\n got %s\nwant %s", gotJSON, wantJSON)
	}
}

// TestCoveragePlannerParamUsesColumnFunction: a parameter compared with a column function takes the
// function's result type, or the column when the result has the column's type.
func TestCoveragePlannerParamUsesColumnFunction(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_column_function")
}

// TestCoveragePlannerParamUsesInterval: the interval of a relative time function is i32, or f64 for seconds.
func TestCoveragePlannerParamUsesInterval(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_interval")
}

// TestCoveragePlannerParamUsesContains: the value of contains and contains_binary is text.
func TestCoveragePlannerParamUsesContains(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_contains")
}

// TestCoveragePlannerParamUsesIfParent: the value of if_parent takes the parent column.
func TestCoveragePlannerParamUsesIfParent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_if_parent")
}

// TestCoveragePlannerParamUsesOptimistic: the value of optimistic takes its column.
func TestCoveragePlannerParamUsesOptimistic(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_optimistic")
}

// TestCoveragePlanner runs every case of contracts/fixtures/planner.json as a subtest named by its id,
// with the test of that case, so the parity check runs the suite under its case ids.
func TestCoveragePlanner(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	runFixtureCases(t, "planner", map[string]func(*testing.T){
		"planner_statement":                                        TestCoveragePlannerStatement,
		"planner_count":                                            TestCoveragePlannerCount,
		"planner_contains_ascii_fold":                              TestCoveragePlannerContainsAsciiFold,
		"planner_contains_binary_collation":                        TestCoveragePlannerContainsBinaryCollation,
		"planner_rejects_unknown_column":                           TestCoveragePlannerRejectsUnknownColumn,
		"planner_restore":                                          TestCoveragePlannerRestore,
		"planner_restore_rejects_non_key":                          TestCoveragePlannerRestoreRejectsNonKey,
		"planner_restore_key_from_set":                             TestCoveragePlannerRestoreKeyFromSet,
		"planner_restore_extra_condition":                          TestCoveragePlannerRestoreExtraCondition,
		"planner_restore_primary_key_first":                        TestCoveragePlannerRestorePrimaryKeyFirst,
		"planner_restore_first_unique_by_name":                     TestCoveragePlannerRestoreFirstUniqueByName,
		"planner_tables":                                           TestCoveragePlannerTables,
		"planner_bind_types_select":                                TestCoveragePlannerBindTypesSelect,
		"planner_bind_types_update":                                TestCoveragePlannerBindTypesUpdate,
		"planner_bind_types_insert":                                TestCoveragePlannerBindTypesInsert,
		"planner_time_select":                                      TestCoveragePlannerTimeSelect,
		"planner_time_insert":                                      TestCoveragePlannerTimeInsert,
		"planner_clock_compare":                                    TestCoveragePlannerClockCompare,
		"planner_clock_insert":                                     TestCoveragePlannerClockInsert,
		"planner_parent_key_types":                                 TestCoveragePlannerParentKeyTypes,
		"planner_not_group":                                        TestCoveragePlannerNotGroup,
		"planner_rejects_top_not":                                  TestCoveragePlannerRejectsTopNot,
		"planner_rejects_top_group_conn":                           TestCoveragePlannerRejectsTopGroupConn,
		"planner_rejects_first_item_conn":                          TestCoveragePlannerRejectsFirstItemConn,
		"planner_column_refs":                                      TestCoveragePlannerColumnRefs,
		"planner_rejects_ref_unknown_column":                       TestCoveragePlannerRejectsRefUnknownColumn,
		"planner_rejects_outer_ref_outside_subquery":               TestCoveragePlannerRejectsOuterRefOutsideSubquery,
		"planner_rejects_unjoined_ref":                             TestCoveragePlannerRejectsUnjoinedRef,
		"planner_ref_path_absent":                                  TestCoveragePlannerRefPathAbsent,
		"planner_group_by_count":                                   TestCoveragePlannerGroupByCount,
		"planner_group_count_order_column":                         TestCoveragePlannerGroupCountOrderColumn,
		"planner_group_count_order_column_function":                TestCoveragePlannerGroupCountOrderColumnFunction,
		"planner_group_count_order_random":                         TestCoveragePlannerGroupCountOrderRandom,
		"planner_rejects_group_by_all":                             TestCoveragePlannerRejectsGroupByAll,
		"planner_rejects_group_by_sum":                             TestCoveragePlannerRejectsGroupBySum,
		"planner_rejects_group_by_join":                            TestCoveragePlannerRejectsGroupByJoin,
		"planner_rejects_group_by_subquery":                        TestCoveragePlannerRejectsGroupBySubquery,
		"planner_rejects_group_order_non_group_column":             TestCoveragePlannerRejectsGroupOrderNonGroupColumn,
		"planner_rejects_nullable_key_by":                          TestCoveragePlannerRejectsNullableKeyBy,
		"planner_key_by_empty_is_absent":                           TestCoveragePlannerKeyByEmptyIsAbsent,
		"planner_insert_by_value":                                  TestCoveragePlannerInsertByValue,
		"planner_rejects_insert_set_plus":                          TestCoveragePlannerRejectsInsertSetPlus,
		"planner_rejects_insert_set_minus":                         TestCoveragePlannerRejectsInsertSetMinus,
		"planner_ip_eq_col_ip":                                     TestCoveragePlannerIpEqColIp,
		"planner_rejects_bool_gt_col":                              TestCoveragePlannerRejectsBoolGtCol,
		"planner_rejects_ip_gt_col":                                TestCoveragePlannerRejectsIpGtCol,
		"planner_rejects_aes_eq_col":                               TestCoveragePlannerRejectsAesEqCol,
		"planner_col_pair_integers":                                TestCoveragePlannerColPairIntegers,
		"planner_rejects_col_pair_integer_varchar":                 TestCoveragePlannerRejectsColPairIntegerVarchar,
		"planner_rejects_in_subquery_integer_varchar":              TestCoveragePlannerRejectsInSubqueryIntegerVarchar,
		"planner_rejects_join_integer_varchar":                     TestCoveragePlannerRejectsJoinIntegerVarchar,
		"planner_rejects_relation_integer_varchar":                 TestCoveragePlannerRejectsRelationIntegerVarchar,
		"planner_insert_on_duplicate_plus":                         TestCoveragePlannerInsertOnDuplicatePlus,
		"planner_rejects_upsert_primary_and_unique_key":            TestCoveragePlannerRejectsUpsertPrimaryAndUniqueKey,
		"planner_rejects_upsert_unique_key_not_assigned":           TestCoveragePlannerRejectsUpsertUniqueKeyNotAssigned,
		"planner_rejects_upsert_without_a_key":                     TestCoveragePlannerRejectsUpsertWithoutAKey,
		"planner_order_nullable_column":                            TestCoveragePlannerOrderNullableColumn,
		"planner_order_not_null_column":                            TestCoveragePlannerOrderNotNullColumn,
		"planner_order_nullable_column_function":                   TestCoveragePlannerOrderNullableColumnFunction,
		"planner_order_nullable_group_count":                       TestCoveragePlannerOrderNullableGroupCount,
		"planner_order_nullable_limit_per_parent":                  TestCoveragePlannerOrderNullableLimitPerParent,
		"planner_scalar_column_subquery":                           TestCoveragePlannerScalarColumnSubquery,
		"planner_rejects_scalar_column_subquery_without_limit":     TestCoveragePlannerRejectsScalarColumnSubqueryWithoutLimit,
		"planner_rejects_scalar_column_subquery_without_key_order": TestCoveragePlannerRejectsScalarColumnSubqueryWithoutKeyOrder,
		"planner_rejects_in_subquery_limit":                        TestCoveragePlannerRejectsInSubqueryLimit,
		"planner_join_inner_soft_delete":                           TestCoveragePlannerJoinInnerSoftDelete,
		"planner_join_left_soft_delete":                            TestCoveragePlannerJoinLeftSoftDelete,
		"planner_join_on_soft_delete":                              TestCoveragePlannerJoinOnSoftDelete,
		"planner_force_index":                                      TestCoveragePlannerForceIndex,
		"planner_value_function_today":                             TestCoveragePlannerValueFunctionToday,
		"planner_column_function_date":                             TestCoveragePlannerColumnFunctionDate,
		"planner_rejects_column_function_on_varchar":               TestCoveragePlannerRejectsColumnFunctionOnVarchar,
		"planner_rejects_styled_column_equality":                   TestCoveragePlannerRejectsStyledColumnEquality,
		"planner_styled_column_is_null":                            TestCoveragePlannerStyledColumnIsNull,
		"planner_uuid_select":                                      TestCoveragePlannerUuidSelect,
		"planner_uuid_insert":                                      TestCoveragePlannerUuidInsert,
		"param_uses_column_function":                               TestCoveragePlannerParamUsesColumnFunction,
		"param_uses_interval":                                      TestCoveragePlannerParamUsesInterval,
		"param_uses_contains":                                      TestCoveragePlannerParamUsesContains,
		"param_uses_if_parent":                                     TestCoveragePlannerParamUsesIfParent,
		"param_uses_optimistic":                                    TestCoveragePlannerParamUsesOptimistic,
	})
}
