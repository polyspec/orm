package orm

import (
	"context"
	"testing"
)

func TestBindingRejectsExecutorWithoutSchemaEngine(t *testing.T) {
	if _, _, err := NewBinding(context.Background(), &DB{}).Resolve(); err == nil {
		t.Fatal("expected an unbound schema engine to be rejected")
	}
}
