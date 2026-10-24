package testassert

import "testing"

func TestReadColumnReturnsGetterValue(t *testing.T) {
	if got := ReadColumn(t, func() (string, error) { return "value", nil }); got != "value" {
		t.Fatalf("ReadColumn() = %q, want value", got)
	}
}
