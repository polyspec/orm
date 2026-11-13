package orm

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// The update of an unloaded row keeps the assigned columns selected and the key values of its key, so the row
// written by the update reads back as written.
func TestUnloadedUpdateKeepsAssignedValuesSelectedAndKeyed(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	ent := &runtimemodel.Entity{Name: "account", PK: []string{"seq"}}
	c := &Core{sets: []setSpec{
		{column: "seq", value: int64(7)},
		{column: "name", value: "saved"},
		{column: "read_count", value: int64(1), plus: true},
	}}
	c.retainUpdateState(ent, map[string]any{"seq": int64(7)}, false, "")
	if !c.Selected("seq") || !c.Selected("name") || c.Selected("read_count") {
		t.Fatalf("selected after update: seq=%v name=%v read_count=%v", c.Selected("seq"), c.Selected("name"), c.Selected("read_count"))
	}
	keys, err := c.keyValues(ent)
	if err != nil || keys["seq"] != int64(7) {
		t.Fatalf("key values after update = %v, %v; want seq 7", keys, err)
	}
}
