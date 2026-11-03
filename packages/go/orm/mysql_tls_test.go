package orm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestParseDSNMySQLTLS checks that a host name with the TLS parameters parses to its CA and host, with no ssl parameter
// in the native DSN. The refused forms are cases of contracts/fixtures/dsn_reject.
// Requirements: CFG-19.
func TestParseDSNMySQLTLS(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	parsed, err := parseDSN("mysql://root@db.local:3306/orm_example?timezone=UTC&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem", 0)
	if err != nil || parsed.sslCA != "/tmp/ca.pem" || parsed.sslHost != "db.local" || strings.Contains(parsed.native, "ssl") {
		t.Fatalf("parseDSN() = %+v, %v; want the CA /tmp/ca.pem for db.local and no ssl parameter in the native DSN", parsed, err)
	}
}

// TestMySQLSessionSQLMode checks the session sql_mode that the client sets per connection
// against the value in tests/dsn/mysql-session.json: the connection reads the mode it declares,
// not the server default (docs/spec/config.md "Runtime connection").
// Requirements: CFG-3.
func TestMySQLSessionSQLMode(t *testing.T) {
	ctx := testcase.Start(t, testcase.Database).Context()
	dsn := os.Getenv("ORM_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN is required; run make orm-test-servers")
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "dsn", "mysql-session.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		SQLMode struct {
			Session string `json:"session"`
		} `json:"sql_mode"`
	}
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	parsed, err := parseDSN(dsn, 0)
	if err != nil {
		t.Fatal(err)
	}
	db, err := openSQL("mysql", parsed)
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	var mode string
	if err := db.QueryRowContext(ctx, "SELECT @@SESSION.sql_mode").Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != vector.SQLMode.Session {
		t.Errorf("@@SESSION.sql_mode = %q; want %q", mode, vector.SQLMode.Session)
	}
}
