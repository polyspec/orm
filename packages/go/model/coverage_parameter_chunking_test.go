//go:build featurecoverage

package model_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageRootInChunking checks that a root IN list exceeding every driver's bind limit
// runs split into chunks, counts duplicate values only once, and that a limit whose split changes the result
// is IR_INVALID.
func TestCoverageRootInChunking(t *testing.T) {
	testcase.Start(t, testcase.Database)
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
