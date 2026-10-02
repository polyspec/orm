//go:build featurecoverage

package model_test

import (
	"testing"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

// TestCoverageRootInChunking는 모든 driver의 bind 한도를 넘는 root IN list가
// 나뉘어 실행되고, 중복 값은 한 번만 세며, 나누면 결과가 바뀌는 limit은
// IR_INVALID인지 확인한다.
func TestCoverageRootInChunking(t *testing.T) {
	db, _, _ := connectFeature(t)
	values := make([]int64, 0, 70300)
	for seq := int64(1); seq <= 70000; seq++ {
		values = append(values, seq)
	}
	for seq := int64(1); seq <= 200; seq++ {
		values = append(values, seq)
	}
	for seq := int64(200001); seq <= 200100; seq++ {
		values = append(values, seq)
	}
	if n := must(model.Author().Connect(db).Seq(values).GetCount()); n != 70000 {
		t.Fatalf("count of %d IN values = %d, want 70000", len(values), n)
	}
	rows, err := model.Author().Connect(db).Seq(values).Limit(0, 10).Gets()
	if orm.ErrorCode(err) != orm.CodeIrInvalid {
		t.Fatalf("limited split IN = %v rows, %v; want IR_INVALID", rows, err)
	}
}
