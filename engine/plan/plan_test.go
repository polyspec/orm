package plan

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRelationKeysUseOrderedReferences(t *testing.T) {
	raw := `{"step":1,"keys":[{"column":"tenant_id","index":2},{"column":"account_id","index":3}]}`
	var ref ParentRef
	if err := json.Unmarshal([]byte(raw), &ref); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(ref)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if !strings.Contains(text, `"keys":[{"column":"tenant_id","index":2},{"column":"account_id","index":3}]`) {
		t.Fatalf("ordered relation keys were not preserved: %s", text)
	}
	if strings.Contains(text, `"column"`) && !strings.Contains(text, `"keys"`) {
		t.Fatalf("singular relation key structure remains: %s", text)
	}
}
