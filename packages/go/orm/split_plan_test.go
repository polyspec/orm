package orm_test

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// splitPlanAllocationLimit bounds what one split count of 70300 values may allocate in all (runtime TotalAlloc). The
// count allocates about 87 MB: the request and its canonical form, the keys of the values and 138 part plans within
// the SQLite bind limit. Planning the whole list first, a bind slot per padded value, and cloning that list into every
// part took 363 MB (PRT-76, KSTD-7-3-3).
const splitPlanAllocationLimit = 128 << 20

// TestSplitRootInCountPlansNoStatementOverTheBindLimit checks (PRT-76) that a root IN list over the bind limit is split
// before it is planned: the count of 70300 values on SQLite returns the matching rows and allocates less than
// splitPlanAllocationLimit, so no plan holds a bind slot per value of the list.
func TestSplitRootInCountPlansNoStatementOverTheBindLimit(t *testing.T) {
	tc := testcase.Start(t, testcase.Database)
	s := documentSchema(t, keywordSchema)
	db := connectInstalled(t, "sqlite://"+filepath.Join(t.TempDir(), "split-plan.sqlite"), s)
	defer testcase.Close(t, db)
	model := coreFunc(db, keywordEntity(s))
	for _, key := range []string{"first", "second"} {
		c := model()
		c.Set("key", key)
		if _, err := c.Create(); err != nil {
			t.Fatal(err)
		}
	}
	values := make([]int64, 0, 70300)
	for seq := int64(1); seq <= 70300; seq++ {
		values = append(values, seq)
	}
	read := model()
	read.Where("", []orm.ChainKey{{Column: "seq"}}, values)
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	count, err := read.GetCount()
	runtime.ReadMemStats(&after)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("count of the split IN list = %d, want 2", count)
	}
	allocated := after.TotalAlloc - before.TotalAlloc
	tc.Step("the split count allocated %.1f MB", float64(allocated)/(1<<20))
	if allocated >= splitPlanAllocationLimit {
		t.Fatalf("the split count allocated %.1f MB, the limit is %d MB: a plan holds a bind slot per value", float64(allocated)/(1<<20), splitPlanAllocationLimit>>20)
	}
}
