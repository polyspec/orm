package dialect

import "testing"

func TestSQLitePreservesQualifiedPhysicalTableNames(t *testing.T) {
	if got := (SQLite{}).Quote("core.account"); got != `"core__account"` {
		t.Fatalf("qualified SQLite table = %q", got)
	}
	if got := (SQLite{}).Quote("identity_authenticator.credentials"); got != `"identity_authenticator__credentials"` {
		t.Fatalf("provider SQLite table = %q", got)
	}
}
