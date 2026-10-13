package orm

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// TestRelatedAsReportsMismatch는 relation result를 T로 읽을 때 저장된 값,
// related row가 없는 nil, 다른 type의 INTERNAL error를 구별하는지 확인한다.
func TestRelatedAsReportsMismatch(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	c := &Core{row: &rowState{}}
	owner := &GroupRows{}
	c.row.setRelated("owner", owner, false, false)
	c.row.setRelated("absent", nil, false, false)
	c.row.setRelated("wrong", "text", false, false)

	got, err := RelatedAs[*GroupRows](c, "owner")
	if err != nil || got != owner {
		t.Fatalf("stored relation = %p, error = %v; want %p", got, err, owner)
	}
	got, err = RelatedAs[*GroupRows](c, "absent")
	if err != nil || got != nil {
		t.Fatalf("relation without a row = %v, error = %v; want nil", got, err)
	}
	got, err = RelatedAs[*GroupRows](c, "wrong")
	if ErrorCode(err) != CodeInternal || got != nil {
		t.Fatalf("mismatched relation = %v, error = %v; want INTERNAL", got, err)
	}
	for _, part := range []string{"wrong", "string", "*orm.GroupRows"} {
		if !strings.Contains(err.Error(), part) {
			t.Errorf("mismatch error %q does not name %q", err, part)
		}
	}
	if got, err := RelatedAs[*Core](&Core{}, "owner"); err != nil || got != nil {
		t.Fatalf("relation of a model without a row = %v, error = %v; want nil", got, err)
	}
}
