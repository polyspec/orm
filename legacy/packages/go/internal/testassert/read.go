package testassert

import "testing"

// ReadColumn returns a generated model getter's value or fails the current test with its error.
func ReadColumn[T any](t testing.TB, getter func() (T, error)) T {
	t.Helper()
	value, err := getter()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
