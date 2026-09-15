package schema

import "testing"

func TestBuildExternalForeignKey(t *testing.T) {
	m := mustBuild(t, "erDiagram\n  item {\n    uuid id PK\n  }\n  %% orm:table entity=item name=example.items\n  %% orm:foreign entity=item columns=id references=core.instance(instance_uuid) name=item_instance\n")
	if len(m.ExternalFKs) != 1 {
		t.Fatalf("external foreign keys = %d, want 1", len(m.ExternalFKs))
	}
	fk := m.ExternalFKs[0]
	if fk.TargetTable != "core.instance" || fk.TargetCols[0] != "instance_uuid" || fk.Name != "item_instance" {
		t.Fatalf("external foreign key = %+v", fk)
	}
}
