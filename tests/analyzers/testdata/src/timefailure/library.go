package timefailure

import "testing"

// A file that is no test file of a package outside a tests folder is no test.
func limit(t *testing.T, elapsed int) {
	if elapsed > 100 {
		t.Fatal("slow")
	}
}
