package orm

import (
	"context"
	"strings"
	"testing"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: DIA-208, CFG-6, CFG-7.
func TestStatementTimeoutIsTheVariableOfTheServer(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	parsed, err := parseDSN("mysql://orm@127.0.0.1:3306/orm_example", 237)
	if err != nil {
		t.Fatal(err)
	}
	// The DSN names no variable before the server is read.
	if strings.Contains(parsed.native, "max_") {
		t.Fatalf("parsed DSN %s names a statement timeout before the server is read", parsed.native)
	}
	tests := []struct {
		ms   int
		name string
		want string
	}{
		{237, serverMySQL, "&max_execution_time=237"},
		{237, serverMariaDB, "&max_statement_time=0.237"},
		{1500, serverMariaDB, "&max_statement_time=1.500"},
		{5, serverMariaDB, "&max_statement_time=0.005"},
	}
	for _, tt := range tests {
		d := parsed
		d.statementTimeoutMs = tt.ms
		if got := d.withStatementTimeout(tt.name).native; !strings.HasSuffix(got, tt.want) || strings.Count(got, "max_") != 1 {
			t.Errorf("%s %d ms: %s, want the suffix %s", tt.name, tt.ms, got, tt.want)
		}
	}
	if _, err := mysql.ParseDSN(parsed.withStatementTimeout(serverMariaDB).native); err != nil {
		t.Fatalf("the driver refuses the DSN: %v", err)
	}
}

// Requirements: DIA-209, INT-49, CFG-6.
func TestMariaDBLockWaitOfANowaitLockIsLockNotAvailable(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	wait := &mysql.MySQLError{Number: 1205, Message: "Lock wait timeout exceeded; try restarting transaction"}
	tests := []struct {
		server, lock, want string
	}{
		{serverMariaDB, "update_nowait", CodeLockNotAvailable},
		{serverMariaDB, "share_nowait", CodeLockNotAvailable},
		{serverMariaDB, "update", CodeCanceled},
		{serverMariaDB, "", CodeCanceled},
		{serverMySQL, "update_nowait", CodeCanceled},
	}
	for _, tt := range tests {
		if got := ErrorCode(mapLockedErr(wait, context.Background(), tt.server, tt.lock)); got != tt.want {
			t.Errorf("%s lock %q: %s, want %s", tt.server, tt.lock, got, tt.want)
		}
	}
	if got := ErrorCode(mapLockedErr(&mysql.MySQLError{Number: 3572}, context.Background(), serverMySQL, "update_nowait")); got != CodeLockNotAvailable {
		t.Errorf("MySQL 3572: %s", got)
	}
}
