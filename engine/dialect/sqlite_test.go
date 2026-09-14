package dialect

import "testing"

func TestSQLiteFlattensQualifiedPhysicalTableNames(t *testing.T) {
	if got := (SQLite{}).Quote("core.account"); got != `"account"` {
		t.Fatalf("qualified SQLite table = %q", got)
	}
}
