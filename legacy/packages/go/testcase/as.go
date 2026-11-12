package testcase

import (
	"fmt"
	"testing"
)

// As returns v as a T; a value of another type fails the test.
func As[T any](t testing.TB, v any) T {
	t.Helper()
	out, err := AsErr[T](v)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// AsErr returns v as a T, or an error when v is another type.
func AsErr[T any](v any) (T, error) {
	out, ok := v.(T)
	if !ok {
		var zero T
		return zero, fmt.Errorf("value is %T, not %T", v, zero)
	}
	return out, nil
}
