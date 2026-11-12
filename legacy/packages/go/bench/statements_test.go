package bench

import (
	"context"
	"sync"
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestNativeStatementsEqualClient checks that the native side of the hot-path gate runs
// the same statement as the SQL text that the generated client runs. If the statements of the two sides
// differ, the gate's ratio measures the statement difference, not the client cost.
func TestNativeStatementsEqualClient(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, err := model.Connect(dsn(t), orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	var mu sync.Mutex
	var seen []string
	if _, err := db.Subscribe(func(e orm.StatementEvent) error {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, e.SQL)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := model.Author().Connect(db).GetBySeq(42); err != nil {
		t.Fatal(err)
	}
	if _, err := model.Author().Connect(db).ServiceSeq(7).AndIsClose(false).OrderBySeqDesc().Limit(0, 100).Gets(); err != nil {
		t.Fatal(err)
	}
	want := []string{pkSQL, list100SQL}
	if len(seen) != len(want) {
		t.Fatalf("client ran %d statements, want %d: %q", len(seen), len(want), seen)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Errorf("statement %d\nclient %s\nnative %s", i, seen[i], want[i])
		}
	}
}

// TestNativeWorkloadsRead checks that the native read workloads of the gate and the benchmark
// read rows from the seeded bench database and finish without error.
func TestNativeWorkloadsRead(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db := open(t)
	defer testcase.Close(t, db)
	ctx := context.Background()
	if b, err := pkGet(ctx, db, 42); err != nil || b == nil || b.Seq != 42 {
		t.Fatalf("pkGet(42) = %v, %v", b, err)
	}
	if rows, err := list100(ctx, db, 7); err != nil || len(rows) != 100 {
		t.Fatalf("list100(7) = %d rows, %v", len(rows), err)
	}
	if rows, err := listN(ctx, db, 7, 20); err != nil || len(rows) != 20 {
		t.Fatalf("listN(7, 20) = %d rows, %v", len(rows), err)
	}
	children, err := relation4(ctx, db, 7)
	if err != nil || len(children) == 0 {
		t.Fatalf("relation4(7) = %d parents, %v", len(children), err)
	}
}
