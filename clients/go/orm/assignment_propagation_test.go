package orm

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/schema"
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
	asm := &plan.Assemble{Columns: []plan.OutCol{{Index: 0, Name: "name", Column: "name", Type: "string"}}}
	cache := &cached{}
	cache.shapes.Store(asm, &rowShape{names: []string{"name"}, time: []bool{false}})
	a := &assembler{res: &result{cache: cache}}
	_, err := a.model(NewCore(ent), asm, []any{"value"})
	if !errors.Is(err, want) {
		t.Fatalf("assignment error: %v", err)
	}
}

func TestAutoAssignmentValidationBeforeWrite(t *testing.T) {
	ent := &Entity{New: func(c *Core) Model { m := &rejectingModel{core: c}; c.Bind(m); return m }}
	ent.Assign = func(Model, string, any) (bool, error) { return true, nil }
	m := ent.New(NewCore(ent))
	col := &schema.Col{Name: "seq", Type: "i64", PK: true}
	manifest := &schema.Entity{Auto: "seq", Columns: []*schema.Col{col}}
	if err := validateAutoAssignment(manifest, ent, m); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func()
		reset  func()
	}{
		{"type", func() { col.Type = "i32" }, func() { col.Type = "i64" }},
		{"nullable", func() { col.Nullable = true }, func() { col.Nullable = false }},
		{"unsigned", func() { col.Unsigned = true }, func() { col.Unsigned = false }},
		{"primary key", func() { col.PK = false }, func() { col.PK = true }},
	} {
		tc.change()
		err := validateAutoAssignment(manifest, ent, m)
		tc.reset()
		if code := ErrorCode(err); code != CodeSchemaInvalid {
			t.Errorf("%s auto key code %q: %v", tc.name, code, err)
		}
	}
	want := errors.New("generated assignment failed")
	ent.Assign = func(Model, string, any) (bool, error) { return true, want }
	if err := validateAutoAssignment(manifest, ent, m); !errors.Is(err, want) {
		t.Fatalf("assignment error: %v", err)
	}
	ent.Assign = func(Model, string, any) (bool, error) { return false, nil }
	if code := ErrorCode(validateAutoAssignment(manifest, ent, m)); code != CodeInternal {
		t.Fatalf("missing generated column code %q", code)
	}
}
