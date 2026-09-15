package schema

import "testing"

func TestBuildImmutableEntity(t *testing.T) {
	m := mustBuild(t, "erDiagram\n  revision {\n    uuid id PK\n  }\n  %% orm:immutable entity=revision\n")
	if len(m.Immutable) != 1 || m.Immutable[0] != "revision" {
		t.Fatalf("immutable entities = %#v", m.Immutable)
	}
}
