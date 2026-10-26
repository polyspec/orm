package testassert

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

func TestReadColumnReturnsGetterValue(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	if got := ReadColumn(t, func() (string, error) { return "value", nil }); got != "value" {
		t.Fatalf("ReadColumn() = %q, want value", got)
	}
}
