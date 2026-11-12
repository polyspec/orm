package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// A test of the private fetchKey of a model: a key callback whose result is not a key is refused.

func TestModelCollectionKeyRejectsInvalidCallback(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	core := NewCore(nil)
	core.fetchKey = func(Model) any { return struct{}{} }
	if _, err := core.collectionKey(&Core{self: &rejectingModel{}}, nil, nil); err == nil {
		t.Fatal("invalid fetch key callback result was accepted")
	}
}
