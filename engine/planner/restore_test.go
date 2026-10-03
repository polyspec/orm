package planner

import (
	"fmt"
	"testing"

	"github.com/polyspec/orm/engine/dialect"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
)

// restoreDocument는 unique key를 가진 soft delete table 두 개다. link는 audit
// table이고 tag는 아니며, plain에는 soft_delete가 없다.
const restoreDocument = `dbspec 1 restore

table link {
  id i64 identity
  team_id i64
  member_id i64
  operation_id i64
  deleted_at datetime(6) null
  primary key (id)
  unique uq_link_pair (team_id, member_id)
  settings {
    soft_delete deleted_at
    audit into link_history operation operation_id action change previous previous_operation_id
  }
}

table link_history {
  history_id i64 identity
  change varchar(8)
  previous_operation_id i64 null
  id i64
  team_id i64
  member_id i64
  operation_id i64
  deleted_at datetime(6) null
  primary key (history_id)
}

table tag {
  id i64 identity
  name varchar(64)
  label varchar(64)
  deleted_at datetime(6) null
  primary key (id)
  unique uq_tag_name (name)
  settings {
    soft_delete deleted_at
  }
}

table plain {
  id i64 identity
  name varchar(64)
  primary key (id)
}
`

// restoreRequest는 columns의 eq 조건으로 entity를 restore하는 request다. op와
// conn은 column마다 바꿀 수 있다.
func restoreRequest(m *runtimemodel.Model, entity string, preds ...ir.Pred) *ir.Request {
	r := &ir.Request{IRVersion: ir.Version, ManifestHash: m.ManifestHash, Kind: "restore", Query: ir.Query{Entity: entity, Where: &ir.Group{}}}
	for i := range preds {
		p := preds[i]
		if p.P == nil && p.Op != "is_null" {
			n := r.NParams
			p.P = &n
			r.NParams++
		}
		r.Where.Items = append(r.Where.Items, ir.Item{Pred: &p})
	}
	return r
}

// withSet은 request에 새 값의 assignment를 더한다. 값의 parameter는 조건 뒤에
// 이어진다.
func withSet(r *ir.Request, assigns ...ir.Assign) *ir.Request {
	for _, a := range assigns {
		n := r.NParams
		a.P = &n
		r.NParams++
		r.Set = append(r.Set, a)
	}
	return r
}

// compileRestore는 request를 검증하고 dialect로 compile한다.
func compileRestore(m *runtimemodel.Model, d dialect.Dialect, r *ir.Request) (*plan.Plan, error) {
	if err := ir.Validate(m, r); err != nil {
		return nil, err
	}
	return (&Planner{M: m, D: d}).Compile(r)
}

// TestRestorePlansGuardedUpdate는 restore가 primary key나 unique key 하나의
// eq 조건으로 soft delete column을 NULL로 되돌리는 update 하나가 되는지
// 확인한다. 지워진 행만 고치고, audit table이면 operation column도 쓴다.
func TestRestorePlansGuardedUpdate(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	m := testModel(t, restoreDocument)
	for _, tc := range []struct {
		name    string
		d       dialect.Dialect
		request *ir.Request
		sql     string
		slots   []string
	}{
		{"unique key with audit", dialect.SQLite{}, restoreRequest(m, "link", ir.Pred{Column: "team_id", Op: "eq"}, ir.Pred{Conn: "and", Column: "member_id", Op: "eq"}),
			`UPDATE "link" SET "deleted_at" = NULL, "operation_id" = ? WHERE "link"."team_id" = ? AND "link"."member_id" = ? AND "link"."deleted_at" IS NOT NULL`,
			[]string{"operation", "param 0", "param 1"}},
		{"unique key in another order", dialect.MySQL{}, restoreRequest(m, "link", ir.Pred{Column: "member_id", Op: "eq"}, ir.Pred{Conn: "and", Column: "team_id", Op: "eq"}),
			"UPDATE `link` SET `deleted_at` = NULL, `operation_id` = ? WHERE `link`.`member_id` = ? AND `link`.`team_id` = ? AND `link`.`deleted_at` IS NOT NULL",
			[]string{"operation", "param 0", "param 1"}},
		{"primary key", dialect.Postgres{}, restoreRequest(m, "link", ir.Pred{Column: "id", Op: "eq"}),
			`UPDATE "link" SET "deleted_at" = NULL, "operation_id" = $1 WHERE "link"."id" = $2 AND "link"."deleted_at" IS NOT NULL`,
			[]string{"operation", "param 0"}},
		{"without audit", dialect.MySQL{}, restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}),
			"UPDATE `tag` SET `deleted_at` = NULL WHERE `tag`.`name` = ? AND `tag`.`deleted_at` IS NOT NULL",
			[]string{"param 0"}},
		{"new values", dialect.SQLite{}, withSet(restoreRequest(m, "link", ir.Pred{Column: "team_id", Op: "eq"}, ir.Pred{Conn: "and", Column: "member_id", Op: "eq"}), ir.Assign{Column: "team_id"}),
			`UPDATE "link" SET "team_id" = ?, "deleted_at" = NULL, "operation_id" = ? WHERE "link"."team_id" = ? AND "link"."member_id" = ? AND "link"."deleted_at" IS NOT NULL`,
			[]string{"param 2", "operation", "param 0", "param 1"}},
		{"new value and null", dialect.Postgres{}, withSet(restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}), ir.Assign{Column: "label"}),
			`UPDATE "tag" SET "label" = $1, "deleted_at" = NULL WHERE "tag"."name" = $2 AND "tag"."deleted_at" IS NOT NULL`,
			[]string{"param 1", "param 0"}},
	} {
		p, err := compileRestore(m, tc.d, tc.request)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if len(p.Steps) != 1 || p.Steps[0].Role != "main" || p.Steps[0].SQL != tc.sql {
			t.Fatalf("%s: plan %+v\nwant one main step %s", tc.name, p.Steps, tc.sql)
		}
		var slots []string
		for _, s := range p.Steps[0].BindSlots {
			if s.From == "param" {
				slots = append(slots, fmt.Sprintf("param %d", s.Param))
			} else {
				slots = append(slots, s.From)
			}
		}
		if fmt.Sprint(slots) != fmt.Sprint(tc.slots) {
			t.Fatalf("%s: bind slots %v, want %v", tc.name, slots, tc.slots)
		}
	}
}

// TestRestoreRejectsOtherRequests는 key 하나를 eq 값으로 정확히 이름하지 않는
// restore와 soft_delete가 없는 table의 restore가 IR_INVALID인지 확인한다.
func TestRestoreRejectsOtherRequests(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	m := testModel(t, restoreDocument)
	set := func(r *ir.Request, change func(*ir.Request)) *ir.Request { change(r); return r }
	for name, r := range map[string]*ir.Request{
		"part of a unique key":     restoreRequest(m, "link", ir.Pred{Column: "team_id", Op: "eq"}),
		"a column that is no key":  restoreRequest(m, "tag", ir.Pred{Column: "label", Op: "eq"}),
		"a key and another column": restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}, ir.Pred{Conn: "and", Column: "label", Op: "eq"}),
		"a repeated column":        restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}, ir.Pred{Conn: "and", Column: "name", Op: "eq"}),
		"another operator":         restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "gt"}),
		"an or connector":          restoreRequest(m, "link", ir.Pred{Column: "team_id", Op: "eq"}, ir.Pred{Conn: "or", Column: "member_id", Op: "eq"}),
		"a null test":              restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "is_null"}),
		"no condition":             restoreRequest(m, "tag"),
		"a group": set(restoreRequest(m, "tag"), func(r *ir.Request) {
			p := 0
			r.NParams = 1
			r.Where.Items = []ir.Item{{Group: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "name", Op: "eq", P: &p}}}}}}
		}),
		"an assignment of the soft delete column": withSet(restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}), ir.Assign{Column: "deleted_at"}),
		"an assignment of the primary key":        withSet(restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}), ir.Assign{Column: "id"}),
		"an assignment of the operation column":   withSet(restoreRequest(m, "link", ir.Pred{Column: "id", Op: "eq"}), ir.Assign{Column: "operation_id"}),
		"an optimistic check": set(restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}), func(r *ir.Request) {
			r.Optimistic = &ir.Optimist{Column: "label", P: 0}
		}),
		"a table without soft_delete": restoreRequest(m, "plain", ir.Pred{Column: "id", Op: "eq"}),
	} {
		_, err := compileRestore(m, dialect.SQLite{}, r)
		if e, ok := err.(*ir.Error); !ok || e.Code != "IR_INVALID" {
			t.Errorf("%s: %v, want IR_INVALID", name, err)
		}
	}
}
