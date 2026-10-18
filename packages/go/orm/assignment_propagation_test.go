package orm

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

type rejectingModel struct{ core *Core }

func (m *rejectingModel) Orm_() *Core { return m.core }

func TestAssemblerReturnsAssignmentError(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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

// TestIdentityAssignmentValidationBeforeWrite checks an identity field before writing it
// into the generated model, and returns an error if the assignment fails or the field is missing.
// The dbspec parser enforces the type rules of identity columns.
func TestIdentityAssignmentValidationBeforeWrite(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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
