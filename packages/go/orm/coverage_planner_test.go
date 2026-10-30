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

// coveragePlannerStatement compiles a row select with a condition, ordering, and limit.
func coveragePlannerStatement(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_statement")
}

// coveragePlannerCount compiles a count.
func coveragePlannerCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_count")
}

// coveragePlannerContainsBinaryCollation checks that contains_binary compiles on MySQL to a LIKE under the binary collation.
func coveragePlannerContainsBinaryCollation(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_contains_binary_collation")
}

// coveragePlannerContainsAsciiFold checks that contains compiles on MySQL to a 26-level REPLACE that folds only ASCII letters.
func coveragePlannerContainsAsciiFold(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_contains_ascii_fold")
}

// coveragePlannerRejectsUnknownColumn checks that a condition on a missing column is COLUMN_UNKNOWN.
func coveragePlannerRejectsUnknownColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_unknown_column")
}

// Requirements: DSL-24.
func coveragePlannerRejectsColumnFunctionUnknownColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_column_function_unknown_column")
}

// coveragePlannerRestore compiles a restore that brings back a soft-deleted row by primary key.
func coveragePlannerRestore(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore")
}

// coveragePlannerRestoreRejectsNonKey checks that a restore on a non-key column is IR_INVALID.
func coveragePlannerRestoreRejectsNonKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore_rejects_non_key")
}

// coveragePlannerRestoreKeyFromSet compiles a restore whose set names the primary key, which becomes the condition.
func coveragePlannerRestoreKeyFromSet(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore_key_from_set")
}

// coveragePlannerRestoreExtraCondition compiles a restore whose where narrows the key of its set.
func coveragePlannerRestoreExtraCondition(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore_extra_condition")
}

// coveragePlannerRestorePrimaryKeyFirst compiles a restore whose set covers the primary key and a unique key.
func coveragePlannerRestorePrimaryKeyFirst(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore_primary_key_first")
}

// coveragePlannerIpHexInsert compiles an insert of a column of codec ip hex, whose address the client packs on every dialect.
func coveragePlannerIpHexInsert(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_ip_hex_insert")
}

// coveragePlannerIpHexSelect compiles a select that reads a column of codec ip hex without a SQL-side ip stage.
func coveragePlannerIpHexSelect(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_ip_hex_select")
}

// coveragePlannerIpHexEq compiles an eq on a column of codec ip hex, whose stored form is a deterministic function of the value.
func coveragePlannerIpHexEq(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_ip_hex_eq")
}

// coveragePlannerHexEq compiles an eq on a column of codec hex, whose stored form is a deterministic function of the value.
func coveragePlannerHexEq(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_hex_eq")
}

// coveragePlannerAesHexEq compiles an eq on a column of codec aes hex through its blind index.
func coveragePlannerAesHexEq(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_aes_hex_eq")
}

// coveragePlannerHexAesEq compiles an eq on a column of codec hex aes through its blind index, which hashes the value whatever the stage order.
func coveragePlannerHexAesEq(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_hex_aes_eq")
}

// coveragePlannerOrderedJsonAesEq refuses an eq on a column of codec ordered_json aes, whose predicate value is not encoded by the ordered_json stage.
func coveragePlannerOrderedJsonAesEq(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_ordered_json_aes_eq")
}

// coveragePlannerRestoreFirstUniqueByName compiles a restore whose set covers two unique keys.
func coveragePlannerRestoreFirstUniqueByName(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore_first_unique_by_name")
}

// coveragePlannerTables checks, for each step of a select with a subquery, join, and relation,
// the table that the statement uses by name.
// Requirements: PRT-37.
func coveragePlannerTables(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_tables")
}

// coveragePlannerBindTypesSelect checks that select condition slots carry the types of columns, functions, and relative time functions.
func coveragePlannerBindTypesSelect(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_select")
}

// coveragePlannerBindTypesUpdate checks the types of the update assignment, AES, blind index, config, and optimistic slots.
func coveragePlannerBindTypesUpdate(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_update")
}

// coveragePlannerBindTypesInsert checks the types of the insert values, AES, blind index, config, and now slots.
func coveragePlannerBindTypesInsert(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_insert")
}

// coveragePlannerTimeSelect reads a time(p) column as text with p digits and binds the compared value as text.
func coveragePlannerTimeSelect(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_time_select")
}

// coveragePlannerTimeInsert binds time(p) and datetime(p) values at the precision of their slot.
func coveragePlannerTimeInsert(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_time_insert")
}

// coveragePlannerUuidSelect reads a PostgreSQL uuid column as text and casts the compared value from text.
func coveragePlannerUuidSelect(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_uuid_select")
}

// coveragePlannerUuidInsert casts a PostgreSQL uuid value from text and writes it.
func coveragePlannerUuidInsert(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_uuid_insert")
}

// coveragePlannerClockCompare binds the value function's clock with six digits, and on SQLite compares datetime(p < 6)
// by extending the column to six digits.
func coveragePlannerClockCompare(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_clock_compare")
}

// coveragePlannerClockInsert checks that on PostgreSQL and SQLite, the default now column the insert omitted
// binds a now slot truncated to the column's fractional digits.
func coveragePlannerClockInsert(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_clock_insert")
}

// coveragePlannerParentKeyTypes checks that the parent slot of a composite key relation carries the key types.
func coveragePlannerParentKeyTypes(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_parent_key_types")
}

// coveragePlannerNotGroup checks that a NOT group in select negates its condition together with the parentheses.
func coveragePlannerNotGroup(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_not_group")
}

// coveragePlannerRejectsTopNot checks that not in a top-level where group is IR_INVALID.
func coveragePlannerRejectsTopNot(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_top_not")
}

// coveragePlannerRejectsTopGroupConn checks that conn in a top-level where group is IR_INVALID.
func coveragePlannerRejectsTopGroupConn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_top_group_conn")
}

// coveragePlannerRejectsFirstItemConn checks that the conn and on the first item of a group is IR_INVALID.
func coveragePlannerRejectsFirstItemConn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_first_item_conn")
}

// coveragePlannerColumnRefs compiles column comparisons that use "^" refs in a join path and in a subquery.
func coveragePlannerColumnRefs(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_column_refs")
}

// coveragePlannerRejectsRefUnknownColumn also validates refs of relations that count does not run, and rejects a missing column
// with COLUMN_UNKNOWN.
func coveragePlannerRejectsRefUnknownColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_ref_unknown_column")
}

// coveragePlannerRejectsOuterRefOutsideSubquery checks that a "^" ref outside a subquery is IR_INVALID.
func coveragePlannerRejectsOuterRefOutsideSubquery(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_outer_ref_outside_subquery")
}

// coveragePlannerRefPathAbsent checks that a ref without a path points to the statement's root.
func coveragePlannerRefPathAbsent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_ref_path_absent")
}

// coveragePlannerRejectsUnjoinedRef checks that a ref to a path not joined in the statement is ENTITY_NOT_JOINED.
func coveragePlannerRejectsUnjoinedRef(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_unjoined_ref")
}

// coveragePlannerGroupByCount checks that a count with group_by counts the groups.
func coveragePlannerGroupByCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_by_count")
}

// coveragePlannerGroupCountOrderColumn checks that group_count is ordered by the group column.
func coveragePlannerGroupCountOrderColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_count_order_column")
}

// coveragePlannerGroupCountOrderColumnFunction checks that group_count is ordered by a column function of the group column.
func coveragePlannerGroupCountOrderColumnFunction(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_count_order_column_function")
}

// coveragePlannerGroupCountOrderRandom checks that group_count is ordered randomly.
func coveragePlannerGroupCountOrderRandom(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_group_count_order_random")
}

// coveragePlannerRejectsGroupByAll checks that group_by on all is IR_INVALID.
func coveragePlannerRejectsGroupByAll(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_all")
}

// coveragePlannerRejectsGroupBySum checks that group_by on sum is IR_INVALID.
func coveragePlannerRejectsGroupBySum(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_sum")
}

// coveragePlannerRejectsGroupByJoin checks that group_by on a join query is IR_INVALID.
func coveragePlannerRejectsGroupByJoin(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_join")
}

// coveragePlannerRejectsGroupBySubquery checks that group_by on a subquery is IR_INVALID.
func coveragePlannerRejectsGroupBySubquery(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_by_subquery")
}

// coveragePlannerRejectsGroupOrderNonGroupColumn checks that ordering a group by a non-group column is IR_INVALID.
func coveragePlannerRejectsGroupOrderNonGroupColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_group_order_non_group_column")
}

// coveragePlannerRejectsNullableKeyBy checks that a nullable key_by column is IR_INVALID.
func coveragePlannerRejectsNullableKeyBy(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_nullable_key_by")
}

// coveragePlannerKeyByEmptyIsAbsent checks that an empty key_by reads as an absent key_by.
func coveragePlannerKeyByEmptyIsAbsent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_key_by_empty_is_absent")
}

// coveragePlannerInsertByValue checks that the insert by value case compiles as expected.
func coveragePlannerInsertByValue(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_insert_by_value")
}

// coveragePlannerInsertOnDuplicatePlus checks that the insert on duplicate plus case compiles as expected.
func coveragePlannerInsertOnDuplicatePlus(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_insert_on_duplicate_plus")
}

// coveragePlannerRejectsInsertSetPlus checks that the rejects insert set plus case compiles as expected.
func coveragePlannerRejectsInsertSetPlus(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_insert_set_plus")
}

// coveragePlannerRejectsInsertSetMinus checks that the rejects insert set minus case compiles as expected.
func coveragePlannerRejectsInsertSetMinus(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_insert_set_minus")
}

// coveragePlannerIpEqColIp checks that the ip eq col ip case compiles as expected.
func coveragePlannerIpEqColIp(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_ip_eq_col_ip")
}

// coveragePlannerRejectsBoolGtCol checks that the rejects bool gt col case compiles as expected.
func coveragePlannerRejectsBoolGtCol(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_bool_gt_col")
}

// coveragePlannerRejectsIpGtCol checks that the rejects ip gt col case compiles as expected.
func coveragePlannerRejectsIpGtCol(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_ip_gt_col")
}

// coveragePlannerRejectsAesEqCol checks that the rejects aes eq col case compiles as expected.
func coveragePlannerRejectsAesEqCol(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_aes_eq_col")
}

// coveragePlannerColPairIntegers checks that the col pair integers case compiles as expected.
func coveragePlannerColPairIntegers(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_col_pair_integers")
}

// coveragePlannerRejectsColPairIntegerVarchar checks that the rejects col pair integer varchar case compiles as expected.
func coveragePlannerRejectsColPairIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_col_pair_integer_varchar")
}

// coveragePlannerRejectsInSubqueryIntegerVarchar checks that the rejects in subquery integer varchar case compiles as expected.
func coveragePlannerRejectsInSubqueryIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_in_subquery_integer_varchar")
}

// coveragePlannerRejectsJoinIntegerVarchar checks that the rejects join integer varchar case compiles as expected.
func coveragePlannerRejectsJoinIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_join_integer_varchar")
}

// coveragePlannerRejectsRelationIntegerVarchar checks that the rejects relation integer varchar case compiles as expected.
func coveragePlannerRejectsRelationIntegerVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_relation_integer_varchar")
}

// coveragePlannerRejectsUpsertPrimaryAndUniqueKey checks that the rejects upsert primary and unique key case compiles as expected.
// Requirements: PRT-6.
func coveragePlannerRejectsUpsertPrimaryAndUniqueKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_upsert_primary_and_unique_key")
}

// coveragePlannerRejectsUpsertUniqueKeyNotAssigned checks that the rejects upsert unique key not assigned case compiles as expected.
// Requirements: PRT-6.
func coveragePlannerRejectsUpsertUniqueKeyNotAssigned(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_upsert_unique_key_not_assigned")
}

// coveragePlannerRejectsUpsertWithoutAKey checks that the rejects upsert without a key case compiles as expected.
// Requirements: PRT-6.
func coveragePlannerRejectsUpsertWithoutAKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_upsert_without_a_key")
}

// coveragePlannerOrderNullableColumn checks that the order nullable column case compiles as expected.
func coveragePlannerOrderNullableColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_column")
}

// coveragePlannerOrderNotNullColumn checks that the order not null column case compiles as expected.
func coveragePlannerOrderNotNullColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_not_null_column")
}

// coveragePlannerOrderNullableColumnFunction checks that the order nullable column function case compiles as expected.
func coveragePlannerOrderNullableColumnFunction(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_column_function")
}

// coveragePlannerOrderNullableGroupCount checks that the order nullable group count case compiles as expected.
func coveragePlannerOrderNullableGroupCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_group_count")
}

// coveragePlannerOrderNullableLimitPerParent checks that the order nullable limit per parent case compiles as expected.
func coveragePlannerOrderNullableLimitPerParent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_order_nullable_limit_per_parent")
}

// coveragePlannerScalarColumnSubquery checks that the scalar column subquery case compiles as expected.
// Requirements: PRT-78.
func coveragePlannerScalarColumnSubquery(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_scalar_column_subquery")
}

// coveragePlannerRejectsScalarColumnSubqueryWithoutLimit checks that the rejects scalar column subquery without limit case compiles as expected.
func coveragePlannerRejectsScalarColumnSubqueryWithoutLimit(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_scalar_column_subquery_without_limit")
}

// coveragePlannerRejectsScalarColumnSubqueryWithoutKeyOrder checks that the rejects scalar column subquery without key order case compiles as expected.
func coveragePlannerRejectsScalarColumnSubqueryWithoutKeyOrder(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_scalar_column_subquery_without_key_order")
}

// coveragePlannerRejectsInSubqueryLimit checks that the rejects in subquery limit case compiles as expected.
func coveragePlannerRejectsInSubqueryLimit(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_in_subquery_limit")
}

// coveragePlannerJoinInnerSoftDelete checks that the join inner soft delete case compiles as expected.
func coveragePlannerJoinInnerSoftDelete(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_join_inner_soft_delete")
}

// coveragePlannerJoinLeftSoftDelete checks that the join left soft delete case compiles as expected.
func coveragePlannerJoinLeftSoftDelete(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_join_left_soft_delete")
}

// coveragePlannerJoinOnSoftDelete checks that the join on soft delete case compiles as expected.
func coveragePlannerJoinOnSoftDelete(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_join_on_soft_delete")
}

// coveragePlannerForceIndex compiles an index hint: MySQL FORCE INDEX, SQLite INDEXED BY, and no hint on PostgreSQL.
func coveragePlannerForceIndex(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_force_index")
}

// coveragePlannerValueFunctionToday compiles today(): MySQL CURDATE(), PostgreSQL CURRENT_DATE, and on SQLite the date of the bound client clock.
func coveragePlannerValueFunctionToday(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_value_function_today")
}

// coveragePlannerColumnFunctionDate compiles the date() column function: MySQL DATE(c), PostgreSQL CAST(c AS date), SQLite date(c).
func coveragePlannerColumnFunctionDate(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_column_function_date")
}

// coveragePlannerRejectsColumnFunctionOnVarchar checks that a column function on a column type it does not list is OPERATOR_NOT_ALLOWED.
func coveragePlannerRejectsColumnFunctionOnVarchar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_column_function_on_varchar")
}

// coveragePlannerRejectsStyledColumnEquality checks that a styled column takes no comparison other than is null and is not null.
func coveragePlannerRejectsStyledColumnEquality(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_styled_column_equality")
}

// coveragePlannerStyledColumnIsNull compiles is null on a styled column.
func coveragePlannerStyledColumnIsNull(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_styled_column_is_null")
}

// Requirements: DSL-95.
func coveragePlannerJoinedChildConditionsGrouped(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_joined_child_conditions_grouped")
}

// Requirements: DSL-95.
func coveragePlannerUnplacedChildConditionsAppendAnd(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_unplaced_child_conditions_append_and")
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
	parameterUses, err := ir.ParamUses(m, &request)
	if err != nil {
		t.Fatal(err)
	}
	for _, uses := range parameterUses {
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

// coveragePlannerParamUsesColumnFunction: a parameter compared with a column function takes the
// function's result type, or the column when the result has the column's type.
// Requirements: DIA-31, PRT-67.
func coveragePlannerParamUsesColumnFunction(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_column_function")
}

// coveragePlannerParamUsesInterval: the interval of a relative time function is i32, or f64 for seconds.
// Requirements: DIA-31, PRT-67.
func coveragePlannerParamUsesInterval(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_interval")
}

// coveragePlannerParamUsesContains: the value of contains and contains_binary is text.
// Requirements: DIA-31, PRT-67.
func coveragePlannerParamUsesContains(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_contains")
}

// coveragePlannerParamUsesIfParent: the value of if_parent takes the parent column.
// Requirements: DIA-31, PRT-67.
func coveragePlannerParamUsesIfParent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_if_parent")
}

// coveragePlannerParamUsesOptimistic: the value of optimistic takes its column.
// Requirements: DIA-31, PRT-67.
func coveragePlannerParamUsesOptimistic(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_optimistic")
}

// TestCoveragePlanner runs every case of contracts/fixtures/planner.json as a subtest named by its id,
// with the test of that case, so the parity check runs the suite under its case ids.
func TestCoveragePlanner(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	runFixtureCases(t, "planner", map[string]func(*testing.T){
		"planner_statement":                                        coveragePlannerStatement,
		"planner_count":                                            coveragePlannerCount,
		"planner_contains_ascii_fold":                              coveragePlannerContainsAsciiFold,
		"planner_contains_binary_collation":                        coveragePlannerContainsBinaryCollation,
		"planner_rejects_column_function_unknown_column":           coveragePlannerRejectsColumnFunctionUnknownColumn,
		"planner_rejects_unknown_column":                           coveragePlannerRejectsUnknownColumn,
		"planner_restore":                                          coveragePlannerRestore,
		"planner_restore_rejects_non_key":                          coveragePlannerRestoreRejectsNonKey,
		"planner_restore_key_from_set":                             coveragePlannerRestoreKeyFromSet,
		"planner_restore_extra_condition":                          coveragePlannerRestoreExtraCondition,
		"planner_restore_primary_key_first":                        coveragePlannerRestorePrimaryKeyFirst,
		"planner_ip_hex_insert":                                    coveragePlannerIpHexInsert,
		"planner_ip_hex_select":                                    coveragePlannerIpHexSelect,
		"planner_ip_hex_eq":                                        coveragePlannerIpHexEq,
		"planner_hex_eq":                                           coveragePlannerHexEq,
		"planner_aes_hex_eq":                                       coveragePlannerAesHexEq,
		"planner_hex_aes_eq":                                       coveragePlannerHexAesEq,
		"planner_ordered_json_aes_eq":                              coveragePlannerOrderedJsonAesEq,
		"planner_restore_first_unique_by_name":                     coveragePlannerRestoreFirstUniqueByName,
		"planner_tables":                                           coveragePlannerTables,
		"planner_bind_types_select":                                coveragePlannerBindTypesSelect,
		"planner_bind_types_update":                                coveragePlannerBindTypesUpdate,
		"planner_bind_types_insert":                                coveragePlannerBindTypesInsert,
		"planner_time_select":                                      coveragePlannerTimeSelect,
		"planner_time_insert":                                      coveragePlannerTimeInsert,
		"planner_clock_compare":                                    coveragePlannerClockCompare,
		"planner_clock_insert":                                     coveragePlannerClockInsert,
		"planner_parent_key_types":                                 coveragePlannerParentKeyTypes,
		"planner_not_group":                                        coveragePlannerNotGroup,
		"planner_rejects_top_not":                                  coveragePlannerRejectsTopNot,
		"planner_rejects_top_group_conn":                           coveragePlannerRejectsTopGroupConn,
		"planner_rejects_first_item_conn":                          coveragePlannerRejectsFirstItemConn,
		"planner_column_refs":                                      coveragePlannerColumnRefs,
		"planner_rejects_ref_unknown_column":                       coveragePlannerRejectsRefUnknownColumn,
		"planner_rejects_outer_ref_outside_subquery":               coveragePlannerRejectsOuterRefOutsideSubquery,
		"planner_rejects_unjoined_ref":                             coveragePlannerRejectsUnjoinedRef,
		"planner_ref_path_absent":                                  coveragePlannerRefPathAbsent,
		"planner_group_by_count":                                   coveragePlannerGroupByCount,
		"planner_group_count_order_column":                         coveragePlannerGroupCountOrderColumn,
		"planner_group_count_order_column_function":                coveragePlannerGroupCountOrderColumnFunction,
		"planner_group_count_order_random":                         coveragePlannerGroupCountOrderRandom,
		"planner_rejects_group_by_all":                             coveragePlannerRejectsGroupByAll,
		"planner_rejects_group_by_sum":                             coveragePlannerRejectsGroupBySum,
		"planner_rejects_group_by_join":                            coveragePlannerRejectsGroupByJoin,
		"planner_rejects_group_by_subquery":                        coveragePlannerRejectsGroupBySubquery,
		"planner_rejects_group_order_non_group_column":             coveragePlannerRejectsGroupOrderNonGroupColumn,
		"planner_rejects_nullable_key_by":                          coveragePlannerRejectsNullableKeyBy,
		"planner_key_by_empty_is_absent":                           coveragePlannerKeyByEmptyIsAbsent,
		"planner_insert_by_value":                                  coveragePlannerInsertByValue,
		"planner_rejects_insert_set_plus":                          coveragePlannerRejectsInsertSetPlus,
		"planner_rejects_insert_set_minus":                         coveragePlannerRejectsInsertSetMinus,
		"planner_ip_eq_col_ip":                                     coveragePlannerIpEqColIp,
		"planner_rejects_bool_gt_col":                              coveragePlannerRejectsBoolGtCol,
		"planner_rejects_ip_gt_col":                                coveragePlannerRejectsIpGtCol,
		"planner_rejects_aes_eq_col":                               coveragePlannerRejectsAesEqCol,
		"planner_col_pair_integers":                                coveragePlannerColPairIntegers,
		"planner_rejects_col_pair_integer_varchar":                 coveragePlannerRejectsColPairIntegerVarchar,
		"planner_rejects_in_subquery_integer_varchar":              coveragePlannerRejectsInSubqueryIntegerVarchar,
		"planner_rejects_join_integer_varchar":                     coveragePlannerRejectsJoinIntegerVarchar,
		"planner_rejects_relation_integer_varchar":                 coveragePlannerRejectsRelationIntegerVarchar,
		"planner_insert_on_duplicate_plus":                         coveragePlannerInsertOnDuplicatePlus,
		"planner_rejects_upsert_primary_and_unique_key":            coveragePlannerRejectsUpsertPrimaryAndUniqueKey,
		"planner_rejects_upsert_unique_key_not_assigned":           coveragePlannerRejectsUpsertUniqueKeyNotAssigned,
		"planner_rejects_upsert_without_a_key":                     coveragePlannerRejectsUpsertWithoutAKey,
		"planner_order_nullable_column":                            coveragePlannerOrderNullableColumn,
		"planner_order_not_null_column":                            coveragePlannerOrderNotNullColumn,
		"planner_order_nullable_column_function":                   coveragePlannerOrderNullableColumnFunction,
		"planner_order_nullable_group_count":                       coveragePlannerOrderNullableGroupCount,
		"planner_order_nullable_limit_per_parent":                  coveragePlannerOrderNullableLimitPerParent,
		"planner_scalar_column_subquery":                           coveragePlannerScalarColumnSubquery,
		"planner_rejects_scalar_column_subquery_without_limit":     coveragePlannerRejectsScalarColumnSubqueryWithoutLimit,
		"planner_rejects_scalar_column_subquery_without_key_order": coveragePlannerRejectsScalarColumnSubqueryWithoutKeyOrder,
		"planner_rejects_in_subquery_limit":                        coveragePlannerRejectsInSubqueryLimit,
		"planner_join_inner_soft_delete":                           coveragePlannerJoinInnerSoftDelete,
		"planner_join_left_soft_delete":                            coveragePlannerJoinLeftSoftDelete,
		"planner_join_on_soft_delete":                              coveragePlannerJoinOnSoftDelete,
		"planner_force_index":                                      coveragePlannerForceIndex,
		"planner_value_function_today":                             coveragePlannerValueFunctionToday,
		"planner_column_function_date":                             coveragePlannerColumnFunctionDate,
		"planner_rejects_column_function_on_varchar":               coveragePlannerRejectsColumnFunctionOnVarchar,
		"planner_rejects_styled_column_equality":                   coveragePlannerRejectsStyledColumnEquality,
		"planner_styled_column_is_null":                            coveragePlannerStyledColumnIsNull,
		"planner_joined_child_conditions_grouped":                  coveragePlannerJoinedChildConditionsGrouped,
		"planner_unplaced_child_conditions_append_and":             coveragePlannerUnplacedChildConditionsAppendAnd,
		"planner_uuid_select":                                      coveragePlannerUuidSelect,
		"planner_uuid_insert":                                      coveragePlannerUuidInsert,
		"param_uses_column_function":                               coveragePlannerParamUsesColumnFunction,
		"param_uses_interval":                                      coveragePlannerParamUsesInterval,
		"param_uses_contains":                                      coveragePlannerParamUsesContains,
		"param_uses_if_parent":                                     coveragePlannerParamUsesIfParent,
		"param_uses_optimistic":                                    coveragePlannerParamUsesOptimistic,
	})
}
