package planner

import (
	"fmt"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/dialect"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

func softDeleteManifest(t *testing.T) *runtimemodel.Model {
	t.Helper()
	return testModel(t, "dbspec 1 soft\n\ntable account {\n  id i64\n  deleted_at datetime(6) null\n  primary key (id)\n  settings {\n    soft_delete deleted_at\n  }\n}\n")
}

func TestSoftDeleteFiltersReads(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	p := &Planner{M: softDeleteManifest(t), D: dialect.SQLite{}}
	plan, err := p.Compile(&ir.Request{Kind: "all", Query: ir.Query{Entity: "account"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan.Steps[0].SQL, `"a"."deleted_at" IS NULL`) {
		t.Fatalf("read plan omitted soft-delete predicate: %s", plan.Steps[0].SQL)
	}
}

func TestSoftDeleteConvertsDeleteToTimestampedUpdate(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	p := &Planner{M: softDeleteManifest(t), D: dialect.SQLite{}}
	param := 0
	plan, err := p.Compile(&ir.Request{
		Kind:    "delete",
		Query:   ir.Query{Entity: "account", Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "id", Op: "eq", P: &param}}}}},
		NParams: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	sql := plan.Steps[0].SQL
	if !strings.HasPrefix(sql, `UPDATE "account" SET "deleted_at" = ?`) || !strings.Contains(sql, `"account"."deleted_at" IS NULL`) {
		t.Fatalf("delete plan did not use guarded soft-delete update: %s", sql)
	}
	if len(plan.Steps[0].BindSlots) != 2 || plan.Steps[0].BindSlots[0].From != "now" || plan.Steps[0].BindSlots[1].From != "param" {
		t.Fatalf("delete plan bind slots differ: %#v", plan.Steps[0].BindSlots)
	}
}

// TestSoftDeleteClockPrecision checks that soft delete uses the database clock at the fractional digits
// declared on the column.
func TestSoftDeleteClockPrecision(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, tc := range []struct {
		column  string
		dialect dialect.Dialect
		want    string
	}{
		{"datetime(6)", dialect.MySQL{}, "UPDATE `account` SET `deleted_at` = CURRENT_TIMESTAMP(6) WHERE"},
		{"datetime(0)", dialect.MySQL{}, "UPDATE `account` SET `deleted_at` = CURRENT_TIMESTAMP WHERE"},
		{"datetime(6)", dialect.Postgres{}, `UPDATE "account" SET "deleted_at" = $1 WHERE`},
		{"datetime(6)", dialect.SQLite{}, `UPDATE "account" SET "deleted_at" = ? WHERE`},
	} {
		m := testModel(t, "dbspec 1 soft\n\ntable account {\n  id i64\n  deleted_at "+tc.column+" null\n  primary key (id)\n  settings {\n    soft_delete deleted_at\n  }\n}\n")
		param := 0
		plan, err := (&Planner{M: m, D: tc.dialect}).Compile(&ir.Request{
			Kind:    "delete",
			Query:   ir.Query{Entity: "account", Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "id", Op: "eq", P: &param}}}}},
			NParams: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		if sql := plan.Steps[0].SQL; !strings.HasPrefix(sql, tc.want) {
			t.Errorf("%s %s: %s, want prefix %s", tc.dialect.Name(), tc.column, sql, tc.want)
		}
	}
}

// TestSoftDeleteClockSlotPrecision checks that the now slot of a SQLite soft delete has the column's fractional digits.
// The executor truncates the clock to those digits, so that
// it satisfies SQLite's datetime(p) CHECK.
func TestSoftDeleteClockSlotPrecision(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, precision := range []int{0, 3, 6} {
		m := testModel(t, fmt.Sprintf("dbspec 1 soft\n\ntable account {\n  id i64\n  deleted_at datetime(%d) null\n  primary key (id)\n  settings {\n    soft_delete deleted_at\n  }\n}\n", precision))
		param := 0
		plan, err := (&Planner{M: m, D: dialect.SQLite{}}).Compile(&ir.Request{
			Kind:    "delete",
			Query:   ir.Query{Entity: "account", Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "id", Op: "eq", P: &param}}}}},
			NParams: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		if slot := plan.Steps[0].BindSlots[0]; slot.From != "now" || slot.Precision != precision {
			t.Errorf("datetime(%d) soft delete slot = %+v", precision, slot)
		}
	}
}
