package orm

import (
	"context"
	"errors"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/testcase"
)

// A test that the private mapDriverErrContext keeps the context cause beside the error it maps, with errors.Join.

func TestMapDriverErrorContextPreservesBothCauses(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	serverCause := errors.New("PostgreSQL canceled the active statement")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	mapped := mapDriverErrContext(&ir.Error{Code: CodeCanceled, Msg: serverCause.Error(), Cause: serverCause}, ctx)
	if !errors.Is(mapped, serverCause) || !errors.Is(mapped, context.Canceled) {
		t.Fatalf("mapped error does not preserve both causes: %#v", mapped)
	}
}
