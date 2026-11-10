package dialect

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: DIA-209, INT-49.
func TestMySQLRowLockOfEachServer(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	tests := []struct {
		mode           string
		mysql, mariadb string
		ok             bool
	}{
		{"update", " FOR UPDATE", " FOR UPDATE", true},
		{"share", " LOCK IN SHARE MODE", " LOCK IN SHARE MODE", true},
		{"update_nowait", " FOR UPDATE NOWAIT", " FOR UPDATE NOWAIT", true},
		{"share_nowait", " FOR SHARE NOWAIT", " LOCK IN SHARE MODE NOWAIT", true},
		{"exclusive", "", "", false},
	}
	for _, tt := range tests {
		for _, server := range []struct {
			d    MySQL
			want string
		}{{MySQL{}, tt.mysql}, {MySQL{MariaDB: true}, tt.mariadb}} {
			if got, ok := server.d.RowLock(tt.mode); got != server.want || ok != tt.ok {
				t.Errorf("%+v RowLock(%q) = %q, %v; want %q, %v", server.d, tt.mode, got, ok, server.want, tt.ok)
			}
		}
	}
	// PostgreSQL keeps FOR SHARE.
	if got, _ := (Postgres{}).RowLock("share"); got != " FOR SHARE" {
		t.Errorf("Postgres RowLock(share) = %q", got)
	}
}
