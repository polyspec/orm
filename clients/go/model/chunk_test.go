package model_test

import (
	"fmt"
	"testing"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

// TestBindLimitSplitting inserts and reads more values than SQLite binds in
// one statement: the inserts and the root IN list are split, duplicate IN
// values are read once, and a shape that a merge would change is rejected.
func TestBindLimitSplitting(t *testing.T) {
	each(t, func(t *testing.T, db *orm.DB) {
		const n = 1200
		rows := make([]*model.ServiceModel, n)
		names := make([]string, 0, n+300)
		for i := range rows {
			name := fmt.Sprintf("chunk-%04d", i)
			rows[i] = model.Service().SetName(name)
			names = append(names, name)
		}
		if inserted := must(model.Service().Connect(db).Creates(rows)); inserted != n {
			t.Fatalf("inserted %d rows", inserted)
		}
		names = append(names, names[:200]...)
		for i := range 100 {
			names = append(names, fmt.Sprintf("missing-%d", i))
		}
		found := must(model.Service().Connect(db).Name(names).Gets())
		if found.Len() != n {
			t.Fatalf("found %d rows, want %d", found.Len(), n)
		}
		if count := must(model.Service().Connect(db).Name(names).GetCount()); count != n {
			t.Fatalf("count %d, want %d", count, n)
		}
		if db.Driver() == "sqlite" {
			_, err := model.Service().Connect(db).Name(names).Limit(0, 10).Gets()
			if orm.ErrorCode(err) != orm.CodeIrInvalid {
				t.Fatalf("limited split: %v", err)
			}
		}
	})
}
