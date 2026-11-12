// Package testcase contains shared assertions for the native Go test harness.
package testcase

import "testing"

// SequenceNameRows reads typed sequence and name values from a client model collection.
// Native SQL rows retain their independent scanners and expected-value checks.
func SequenceNameRows[T interface {
	GetSeq() (int64, error)
	GetName() (string, error)
}](t testing.TB, rows interface{ Slice() []T }) [][2]any {
	t.Helper()
	items := rows.Slice()
	values := make([][2]any, 0, len(items))
	for _, row := range items {
		seq, err := row.GetSeq()
		if err != nil {
			t.Fatal(err)
		}
		name, err := row.GetName()
		if err != nil {
			t.Fatal(err)
		}
		values = append(values, [2]any{seq, name})
	}
	return values
}
