package dbspec

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestSetRoot covers the prefix and the root of step 1: no recipe step states the empty prefix of a set path in the working directory (FCV-2).
// Requirements: DBS-12.
func TestSetRoot(t *testing.T) {
	testcase.Start(t)
	for _, c := range []struct{ path, prefix, root string }{
		{"dbspec-set.json", "", "."},
		{"/dbspec-set.json", "/", "/"},
		{"a/dbspec-set.json", "a/", "a"},
		{"a//dbspec-set.json", "a//", "a"},
		{"/x/a/dbspec-set.json", "/x/a/", "/x/a"},
	} {
		prefix, last := splitSetPath(c.path)
		if prefix != c.prefix || last != SetFileName || setRoot(prefix) != c.root {
			t.Errorf("%s: prefix %q last %q root %q, want %q and %q", c.path, prefix, last, setRoot(prefix), c.prefix, c.root)
		}
	}
}
