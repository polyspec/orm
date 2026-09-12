package orm

import (
	"context"
	"strings"
	"testing"
)

func TestBatchWriteValidatesKindAndEmptyInput(t *testing.T) {
	ctx := context.Background()
	if got, err := BatchWrite(ctx, nil, nil, "merge", BatchOptions{}); err == nil || !strings.Contains(err.Error(), `batch kind "merge" is not supported`) || got != (BatchResult{}) {
		t.Fatalf("invalid batch kind: result=%+v err=%v", got, err)
	}
	got, err := BatchWrite(ctx, nil, nil, "insert", BatchOptions{ChunkSize: 1})
	if err != nil || got != (BatchResult{}) {
		t.Fatalf("empty batch: result=%+v err=%v", got, err)
	}
}
