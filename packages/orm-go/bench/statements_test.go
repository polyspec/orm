package bench

import (
	"context"
	"sync"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/orm-go/model"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

// TestNativeStatementsEqualClient는 hot-path gate의 native 쪽이 generated
// client가 실행하는 SQL text와 같은 statement를 실행하는지 확인한다. 두 쪽의
// statement가 다르면 gate의 ratio는 client 비용이 아니라 statement 차이를 잰다.
func TestNativeStatementsEqualClient(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, err := model.Connect(dsn(t), orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var mu sync.Mutex
	var seen []string
	db.Subscribe(func(e orm.StatementEvent) error {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, e.SQL)
		return nil
	})
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

// TestNativeWorkloadsRead는 gate와 benchmark의 native read workload가
// 시드된 bench database에서 행을 읽고 오류 없이 끝나는지 확인한다.
func TestNativeWorkloadsRead(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db := open(t)
	defer db.Close()
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
