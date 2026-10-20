package planner

import (
	"errors"
	"fmt"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/dialect"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

// restoreDocument is two soft-delete tables with a unique key. link is an audit
// table and not a tag; plain has no soft_delete.
const restoreDocument = `dbspec 1 restore

table link {
  id i64 identity
  team_id i64
  member_id i64
  audit_seq i64
  deleted_at datetime(6) null
  primary key (id)
  unique uq_link_pair (team_id, member_id)
  index ix_link_audit (audit_seq)
  foreign key fk_link_audit (audit_seq) references audit (seq) on delete restrict on update restrict
  settings {
    soft_delete deleted_at
    audit into link_history column audit_seq references audit action change previous previous_audit_seq
  }
}

table link_history {
  history_id i64 identity
  change varchar(8)
  previous_audit_seq i64 null
  id i64
  team_id i64
  member_id i64
  audit_seq i64
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

table audit {
  seq i64 identity
  actor varchar(64)
  primary key (seq)
}

table plain {
  id i64 identity
  name varchar(64)
  primary key (id)
}
`

// restoreRequest is a request that restores an entity by eq conditions on columns. op and
// conn can be changed for each column.
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

// withSet adds an assignment of a new value to the request. The parameter of the value follows
// the conditions.
func withSet(r *ir.Request, assigns ...ir.Assign) *ir.Request {
	for _, a := range assigns {
		n := r.NParams
		a.P = &n
		r.NParams++
		r.Set = append(r.Set, a)
	}
	return r
}

// compileRestore validates the request and compiles it with the dialect.
func compileRestore(m *runtimemodel.Model, d dialect.Dialect, r *ir.Request) (*plan.Plan, error) {
	if err := ir.Validate(m, r); err != nil {
		return nil, err
	}
	return (&Planner{M: m, D: d}).Compile(r)
}

// TestRestorePlansGuardedUpdate checks that restore becomes one update that sets the soft delete column
// back to NULL under an eq condition on one primary or unique key.
// It changes only deleted rows, and for an audit table it also writes the audit columns.
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
			`UPDATE "link" SET "deleted_at" = NULL, "audit_seq" = ? WHERE "link"."team_id" = ? AND "link"."member_id" = ? AND "link"."deleted_at" IS NOT NULL`,
			[]string{"audit", "param 0", "param 1"}},
		{"unique key in another order", dialect.MySQL{}, restoreRequest(m, "link", ir.Pred{Column: "member_id", Op: "eq"}, ir.Pred{Conn: "and", Column: "team_id", Op: "eq"}),
			"UPDATE `link` SET `deleted_at` = NULL, `audit_seq` = ? WHERE `link`.`member_id` = ? AND `link`.`team_id` = ? AND `link`.`deleted_at` IS NOT NULL",
			[]string{"audit", "param 0", "param 1"}},
		{"primary key", dialect.Postgres{}, restoreRequest(m, "link", ir.Pred{Column: "id", Op: "eq"}),
			`UPDATE "link" SET "deleted_at" = NULL, "audit_seq" = $1 WHERE "link"."id" = $2 AND "link"."deleted_at" IS NOT NULL`,
			[]string{"audit", "param 0"}},
		{"without audit", dialect.MySQL{}, restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}),
			"UPDATE `tag` SET `deleted_at` = NULL WHERE `tag`.`name` = ? AND `tag`.`deleted_at` IS NOT NULL",
			[]string{"param 0"}},
		{"key from set and where", dialect.SQLite{}, withSet(restoreRequest(m, "link", ir.Pred{Column: "team_id", Op: "eq"}), ir.Assign{Column: "member_id"}),
			`UPDATE "link" SET "deleted_at" = NULL, "audit_seq" = ? WHERE "link"."team_id" = ? AND "link"."member_id" = ? AND "link"."deleted_at" IS NOT NULL`,
			[]string{"audit", "param 0", "param 1"}},
		{"primary key of set before a unique key of where", dialect.Postgres{}, withSet(restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}), ir.Assign{Column: "id"}, ir.Assign{Column: "label"}),
			`UPDATE "tag" SET "label" = $1, "deleted_at" = NULL WHERE "tag"."name" = $2 AND "tag"."id" = $3 AND "tag"."deleted_at" IS NOT NULL`,
			[]string{"param 2", "param 0", "param 1"}},
		{"new value and null", dialect.Postgres{}, withSet(restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}), ir.Assign{Column: "label"}),
			`UPDATE "tag" SET "label" = $1, "deleted_at" = NULL WHERE "tag"."name" = $2 AND "tag"."deleted_at" IS NOT NULL`,
			[]string{"param 1", "param 0"}},
		{"a key and another condition", dialect.MySQL{}, restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}, ir.Pred{Conn: "and", Column: "label", Op: "gt"}),
			"UPDATE `tag` SET `deleted_at` = NULL WHERE `tag`.`name` = ? AND `tag`.`label` > ? AND `tag`.`deleted_at` IS NOT NULL",
			[]string{"param 0", "param 1"}},
		{"a repeated column", dialect.MySQL{}, restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}, ir.Pred{Conn: "and", Column: "name", Op: "eq"}),
			"UPDATE `tag` SET `deleted_at` = NULL WHERE `tag`.`name` = ? AND `tag`.`name` = ? AND `tag`.`deleted_at` IS NOT NULL",
			[]string{"param 0", "param 1"}},
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

// TestRestoreRejectsOtherRequests checks that a set value and an eq condition in a where joined by and do not overwrite the key,
// that a restore with a where joined by or, a key outside the key, a soft delete, an audit column assignment, and a restore of a table without soft_delete
// are all IR_INVALID.
func TestRestoreRejectsOtherRequests(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	m := testModel(t, restoreDocument)
	set := func(r *ir.Request, change func(*ir.Request)) *ir.Request { change(r); return r }
	for name, r := range map[string]*ir.Request{
		"part of a unique key":              restoreRequest(m, "link", ir.Pred{Column: "team_id", Op: "eq"}),
		"a column that is no key":           restoreRequest(m, "tag", ir.Pred{Column: "label", Op: "eq"}),
		"part of a unique key in set":       withSet(restoreRequest(m, "link"), ir.Assign{Column: "member_id"}),
		"an or connector with a key in set": withSet(restoreRequest(m, "tag", ir.Pred{Column: "label", Op: "eq"}, ir.Pred{Conn: "or", Column: "label", Op: "eq"}), ir.Assign{Column: "name"}),
		"another operator":                  restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "gt"}),
		"an or connector":                   restoreRequest(m, "link", ir.Pred{Column: "team_id", Op: "eq"}, ir.Pred{Conn: "or", Column: "member_id", Op: "eq"}),
		"a null test":                       restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "is_null"}),
		"no condition":                      restoreRequest(m, "tag"),
		"a group": set(restoreRequest(m, "tag"), func(r *ir.Request) {
			p := 0
			r.NParams = 1
			r.Where.Items = []ir.Item{{Group: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "name", Op: "eq", P: &p}}}}}}
		}),
		"an assignment of the soft delete column": withSet(restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}), ir.Assign{Column: "deleted_at"}),
		"a null assignment of the primary key": set(restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}), func(r *ir.Request) {
			r.Set = []ir.Assign{{Column: "id", Null: true}}
		}),
		"an assignment of the audit column": withSet(restoreRequest(m, "link", ir.Pred{Column: "id", Op: "eq"}), ir.Assign{Column: "audit_seq"}),
		"an optimistic check": set(restoreRequest(m, "tag", ir.Pred{Column: "name", Op: "eq"}), func(r *ir.Request) {
			r.Optimistic = &ir.Optimist{Column: "label", P: 0}
		}),
		"a table without soft_delete": restoreRequest(m, "plain", ir.Pred{Column: "id", Op: "eq"}),
	} {
		_, err := compileRestore(m, dialect.SQLite{}, r)
		var e *ir.Error
		if !errors.As(err, &e) || e.Code != "IR_INVALID" {
			t.Errorf("%s: %v, want IR_INVALID", name, err)
		}
	}
}
