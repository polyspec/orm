package orm

import (
	"context"
	"errors"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/testcase"
)

// A test that the private mapDriverErrContext keeps the context cause beside the error it maps, with errors.Join.

// errServerCanceled is the cause of the statement that mapCanceledDriverError maps.
var errServerCanceled = errors.New("PostgreSQL canceled the active statement")

// mapCanceledDriverError maps a statement the server canceled under a context that is canceled too.
func mapCanceledDriverError() error {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return mapDriverErrContext(&ir.Error{Code: CodeCanceled, Msg: errServerCanceled.Error(), Cause: errServerCanceled}, ctx, "")
}

func TestMapDriverErrorContextPreservesBothCauses(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	mapped := mapCanceledDriverError()
	if !errors.Is(mapped, errServerCanceled) || !errors.Is(mapped, context.Canceled) {
		t.Fatalf("mapped error does not preserve both causes: %#v", mapped)
	}
}
