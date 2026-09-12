package schema

import (
	"fmt"
	"testing"
)

// TestManifestRoundTripProperty generates a deterministic family of valid
// manifests and checks the invariant that serialization does not change the
// loaded model or schema hash.
func TestManifestRoundTripProperty(t *testing.T) {
	for i := 0; i < 100; i++ {
		src := fmt.Sprintf(`erDiagram
 entity_%d {
   bigint id PK
   varchar(32) name
 }
`, i)
		diagram, err := Parse(src)
		if err != nil {
			t.Fatalf("iteration %d parse: %v", i, err)
		}
		want, err := Build(diagram)
		if err != nil {
			t.Fatalf("iteration %d build: %v", i, err)
		}
		encoded, err := want.MarshalIndent()
		if err != nil {
			t.Fatalf("iteration %d marshal: %v", i, err)
		}
		got, err := Load(encoded)
		if err != nil {
			t.Fatalf("iteration %d load: %v", i, err)
		}
		if got.SchemaHash != want.SchemaHash || len(got.Order) != 1 || got.Order[0] != fmt.Sprintf("entity_%d", i) {
			t.Fatalf("iteration %d round trip changed model: want hash=%s order=%v, got hash=%s order=%v", i, want.SchemaHash, want.Order, got.SchemaHash, got.Order)
		}
	}
}
