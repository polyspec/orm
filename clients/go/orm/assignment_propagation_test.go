package orm

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/runtimemodel"
)

type rejectingModel struct{ core *Core }

func (m *rejectingModel) Orm_() *Core { return m.core }

func TestAssemblerReturnsAssignmentError(t *testing.T) {
	want := errors.New("invalid column value")
	ent := &Entity{
		Name: "record",
		New: func(c *Core) Model {
			m := &rejectingModel{core: c}
			c.Bind(m)
			return m
		},
		Assign: func(Model, string, any) (bool, error) { return true, want },
	}
	asm := &plan.Assemble{Columns: []plan.OutCol{{Index: 0, Name: "name", Column: "name", Type: "varchar"}}}
	cache := &cached{}
	cache.shapes.Store(asm, &rowShape{names: []string{"name"}, time: []bool{false}})
	a := &assembler{res: &result{cache: cache}}
	_, err := a.model(NewCore(ent), asm, []any{"value"})
	if !errors.Is(err, want) {
		t.Fatalf("assignment error: %v", err)
	}
}

// TestIdentityAssignmentValidationBeforeWrite는 identity field를 쓰기 전에
// generated model에 넣고, 넣기가 실패하거나 field가 없으면 error를 반환한다.
// identity column의 type 규칙은 dbspec parser가 지킨다.
func TestIdentityAssignmentValidationBeforeWrite(t *testing.T) {
	ent := &Entity{New: func(c *Core) Model { m := &rejectingModel{core: c}; c.Bind(m); return m }}
	ent.Assign = func(Model, string, any) (bool, error) { return true, nil }
	m := ent.New(NewCore(ent))
	identity := &runtimemodel.Entity{Identity: "seq"}
	if err := validateIdentityAssignment(identity, ent, m); err != nil {
		t.Fatal(err)
	}
	want := errors.New("generated assignment failed")
	ent.Assign = func(Model, string, any) (bool, error) { return true, want }
	if err := validateIdentityAssignment(identity, ent, m); !errors.Is(err, want) {
		t.Fatalf("assignment error: %v", err)
	}
	ent.Assign = func(Model, string, any) (bool, error) { return false, nil }
	if code := ErrorCode(validateIdentityAssignment(identity, ent, m)); code != CodeInternal {
		t.Fatalf("missing generated column code %q", code)
	}
}
