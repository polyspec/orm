package planner

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/dialect"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
)

// testModel은 dbspec document 하나의 runtime model이다.
func testModel(t *testing.T, document string) *runtimemodel.Model {
	t.Helper()
	m, diagnostics := runtimemodel.LoadDocuments([]string{document})
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	return m
}

const runtimeDocument = `dbspec 1 runtime

table note {
  id i64 identity
  rank i16
  body text
  payload bytes null
  meta text null
  secret_note text null
  created_at datetime(6) default now
  primary key (id)
  settings {
    select explicit secret_note
    codec meta ordered_json
  }
}

table item {
  seq i64 identity
  title varchar(191)
  audit_seq i64
  deleted_at datetime(6) null
  primary key (seq)
  index ix_item_audit (audit_seq)
  foreign key fk_item_audit (audit_seq) references audit (seq) on delete restrict on update restrict
  settings {
    soft_delete deleted_at
    audit into item_history column audit_seq references audit action change previous previous_audit_seq
  }
}

table item_history {
  history_id i64 identity
  change varchar(8)
  previous_audit_seq i64 null
  seq i64
  title varchar(191)
  audit_seq i64
  deleted_at datetime(6) null
  primary key (history_id)
  index ix_item_history_row (seq)
}

table audit {
  seq i64 identity
  actor varchar(64)
  primary key (seq)
}
`

func compileRuntime(t *testing.T, d dialect.Dialect, r *ir.Request) (*plan.Plan, error) {
	t.Helper()
	m := testModel(t, runtimeDocument)
	r.IRVersion, r.ManifestHash = ir.Version, m.ManifestHash
	if err := ir.Validate(m, r); err != nil {
		return nil, err
	}
	return (&Planner{M: m, D: d}).Compile(r)
}

func intp(i int) *int { return &i }

// default select set은 select explicit column만 뺀다. text, bytes, codec
// column은 스스로 빠지지 않는다.
func TestDefaultSelectSetLeavesOutOnlySelectExplicit(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	p, err := compileRuntime(t, dialect.MySQL{}, &ir.Request{Kind: "all", Query: ir.Query{Entity: "note"}})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, c := range p.Steps[0].Assemble.Columns {
		names = append(names, c.Name)
	}
	if got := strings.Join(names, ","); got != "id,rank,body,payload,meta,created_at" {
		t.Fatalf("default select set = %s", got)
	}
}

// i16 field는 i16 value type으로 읽히고 plus를 받는다.
func TestI16FieldPlansAsI16(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	p, err := compileRuntime(t, dialect.MySQL{}, &ir.Request{Kind: "all", Query: ir.Query{Entity: "note"}})
	if err != nil {
		t.Fatal(err)
	}
	if c := p.Steps[0].Assemble.Columns[1]; c.Name != "rank" || c.Type != "i16" {
		t.Fatalf("rank output = %+v", c)
	}
	where := &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "id", Op: "eq", P: intp(1)}}}}
	if _, err := compileRuntime(t, dialect.MySQL{}, &ir.Request{Kind: "update", Query: ir.Query{Entity: "note", Where: where}, Set: []ir.Assign{{Column: "rank", PlusP: intp(0)}}, NParams: 2}); err != nil {
		t.Fatalf("plus on i16: %v", err)
	}
}

// insert가 빼먹은 default column은 database default를 받는다. 단 SQLite의
// clock은 millisecond만 가지므로 `default now` column에는 executor의
// microsecond clock을 now slot으로 쓴다(docs/protocol.md).
func TestInsertLeavesDefaultsToTheDatabase(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, d := range []dialect.Dialect{dialect.MySQL{}, dialect.Postgres{}, dialect.SQLite{}} {
		p, err := compileRuntime(t, d, &ir.Request{Kind: "insert", Query: ir.Query{Entity: "note"}, Set: []ir.Assign{{Column: "rank", P: intp(0)}, {Column: "body", P: intp(1)}}, NParams: 2})
		if err != nil {
			t.Fatalf("%s: %v", d.Name(), err)
		}
		slots := p.Steps[0].BindSlots
		if d.HostNow() {
			if !strings.Contains(p.Steps[0].SQL, `"created_at"`) || len(slots) != 3 || slots[2].From != "now" {
				t.Fatalf("%s insert does not bind the clock of created_at: %s %+v", d.Name(), p.Steps[0].SQL, slots)
			}
			continue
		}
		if strings.Contains(p.Steps[0].SQL, "created_at") || len(slots) != 2 {
			t.Fatalf("%s insert fills a default: %s %+v", d.Name(), p.Steps[0].SQL, slots)
		}
	}
	_, err := compileRuntime(t, dialect.SQLite{}, &ir.Request{Kind: "insert", Query: ir.Query{Entity: "note"}, Set: []ir.Assign{{Column: "rank", P: intp(0)}}, NParams: 1})
	if err == nil || !strings.HasPrefix(err.Error(), "IR_INVALID: required column note.body") {
		t.Fatalf("omitted non-null column without default = %v, want IR_INVALID", err)
	}
}

// audit table의 insert, update, soft delete는 audit column에 audit 기록
// entity를 이름한 audit slot을 쓰고, 사용자는 그 column을 쓰지 못한다.
func TestAuditedWritesCarryTheAuditSlot(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	where := &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "seq", Op: "eq", P: intp(0)}}}}
	audits := func(p *plan.Plan) int {
		n := 0
		for _, b := range p.Steps[0].BindSlots {
			if b.From == "audit" {
				if b.Name != "audit" {
					t.Fatalf("audit slot record = %q", b.Name)
				}
				n++
			}
		}
		return n
	}
	insert, err := compileRuntime(t, dialect.MySQL{}, &ir.Request{Kind: "insert", Query: ir.Query{Entity: "item"}, Set: []ir.Assign{{Column: "title", P: intp(0)}}, NParams: 1})
	if err != nil {
		t.Fatal(err)
	}
	if insert.Steps[0].SQL != "INSERT INTO `item` (`title`, `audit_seq`) VALUES (?, ?)" || audits(insert) != 1 {
		t.Fatalf("audited insert: %s %+v", insert.Steps[0].SQL, insert.Steps[0].BindSlots)
	}
	update, err := compileRuntime(t, dialect.MySQL{}, &ir.Request{Kind: "update", Query: ir.Query{Entity: "item", Where: where}, Set: []ir.Assign{{Column: "title", P: intp(1)}}, NParams: 2})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(update.Steps[0].SQL, "UPDATE `item` SET `title` = ?, `audit_seq` = ? WHERE") || audits(update) != 1 {
		t.Fatalf("audited update: %s", update.Steps[0].SQL)
	}
	remove, err := compileRuntime(t, dialect.MySQL{}, &ir.Request{Kind: "delete", Query: ir.Query{Entity: "item", Where: where}, NParams: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(remove.Steps[0].SQL, "UPDATE `item` SET `deleted_at` = CURRENT_TIMESTAMP(6), `audit_seq` = ? WHERE") || audits(remove) != 1 {
		t.Fatalf("audited soft delete: %s", remove.Steps[0].SQL)
	}
	_, err = compileRuntime(t, dialect.MySQL{}, &ir.Request{Kind: "insert", Query: ir.Query{Entity: "item"}, Set: []ir.Assign{{Column: "title", P: intp(0)}, {Column: "audit_seq", P: intp(1)}}, NParams: 2})
	if err == nil || !strings.HasPrefix(err.Error(), "IR_INVALID") {
		t.Fatalf("assigned audit column = %v, want IR_INVALID", err)
	}
}
