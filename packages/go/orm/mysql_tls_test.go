package orm

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	_ "github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestParseDSNMySQLTLS checks the MySQL TLS parameters of docs/spec/config.md:
// ssl-mode=VERIFY_IDENTITY with an absolute ssl-ca path and a host name is the only TLS
// mode; other ssl-mode values, an ssl-ca that is missing or relative, sockets, and an address host
// are CONFIG.
func TestParseDSNMySQLTLS(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	parsed, err := parseDSN("mysql://root@db.local:3306/orm_example?timezone=UTC&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem", 0)
	if err != nil || parsed.sslCA != "/tmp/ca.pem" || parsed.sslHost != "db.local" || strings.Contains(parsed.native, "ssl") {
		t.Fatalf("parseDSN() = %+v, %v; want the CA /tmp/ca.pem for db.local and no ssl parameter in the native DSN", parsed, err)
	}
	for input, wanted := range map[string]string{
		"mysql://root@db.local/orm_example?ssl-mode=VERIFY_CA&ssl-ca=/tmp/ca.pem":                               "ssl-mode",
		"mysql://root@db.local/orm_example?ssl-mode=REQUIRED&ssl-ca=/tmp/ca.pem":                                "ssl-mode",
		"mysql://root@db.local/orm_example?ssl-mode=DISABLED&ssl-ca=/tmp/ca.pem":                                "ssl-mode",
		"mysql://root@db.local/orm_example?ssl-mode=verify_identity&ssl-ca=/tmp/ca.pem":                         "ssl-mode",
		"mysql://root@db.local/orm_example?ssl-mode=&ssl-ca=/tmp/ca.pem":                                        "ssl-mode",
		"mysql://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY":                                            "ssl-ca",
		"mysql://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=ca.pem":                              "absolute",
		"mysql://root@db.local/orm_example?ssl-ca=/tmp/ca.pem":                                                  "ssl-mode",
		"mysql://root@127.0.0.1/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem":                        "host name",
		"mysql://root@[::1]:3306/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem":                       "host name",
		"mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem": "socket",
	} {
		t.Run(input, func(t *testing.T) {
			_, err := parseDSN(input, 0)
			if err == nil || ErrorCode(err) != CodeConfig || !strings.Contains(err.Error(), wanted) {
				t.Fatalf("parseDSN() error = %v; want CONFIG with %q", err, wanted)
			}
		})
	}
}

// TestMySQLTLSConnection connects to the TLS server of make orm-test-servers
// with ssl-mode=VERIFY_IDENTITY to require TLS, and rejects a server whose certificate is signed by another CA or
// has a different host as its name.
func TestMySQLTLSConnection(t *testing.T) {
	ctx := testcase.Start(t, testcase.Database).Context()
	version := func(ctx context.Context, dsn string) (string, error) {
		parsed, err := parseDSN(dsn, 0)
		if err != nil {
			return "", err
		}
		db, err := openSQL("mysql", parsed)
		if err != nil {
			return "", err
		}
		defer db.Close()
		var name, value string
		if err := db.QueryRowContext(ctx, "SHOW SESSION STATUS LIKE 'Ssl_version'").Scan(&name, &value); err != nil {
			return "", err
		}
		return value, nil
	}
	dsns := map[string]string{}
	for _, env := range []string{"ORM_TEST_MYSQL_TLS_DSN", "ORM_TEST_MYSQL_TLS_OTHER_CA_DSN", "ORM_TEST_MYSQL_TLS_MISMATCH_DSN"} {
		if dsns[env] = os.Getenv(env); dsns[env] == "" {
			t.Fatalf("%s is required; run make orm-test-servers", env)
		}
	}
	got, err := version(ctx, dsns["ORM_TEST_MYSQL_TLS_DSN"])
	if err != nil || !regexp.MustCompile(`^TLSv1\.[23]$`).MatchString(got) {
		t.Fatalf("the VERIFY_IDENTITY connection has Ssl_version %q, %v", got, err)
	}
	for name, env := range map[string]string{"another CA": "ORM_TEST_MYSQL_TLS_OTHER_CA_DSN", "a certificate of another host": "ORM_TEST_MYSQL_TLS_MISMATCH_DSN"} {
		if _, err := version(ctx, dsns[env]); err == nil || !strings.Contains(err.Error(), "certificate") {
			t.Errorf("the connection with %s: %v; want a refused certificate", name, err)
		}
	}
}

// TestMySQLSessionSQLMode checks the session sql_mode that the client sets per connection
// against the value in tests/dsn/mysql-session.json: the connection reads the mode it declares,
// not the server default (docs/spec/config.md "Runtime connection").
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
	defer db.Close()
	var mode string
	if err := db.QueryRowContext(ctx, "SELECT @@SESSION.sql_mode").Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != vector.SQLMode.Session {
		t.Errorf("@@SESSION.sql_mode = %q; want %q", mode, vector.SQLMode.Session)
	}
}
