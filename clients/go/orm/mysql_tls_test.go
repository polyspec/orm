package orm

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"

	_ "github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/internal/testcase"
)

// TestParseDSNMySQLTLS는 docs/config.md의 MySQL TLS parameter를 검사한다:
// 절대 경로 ssl-ca와 host 이름을 둔 ssl-mode=VERIFY_IDENTITY가 유일한 TLS
// mode이고, 다른 ssl-mode, 없거나 상대 경로인 ssl-ca, socket, 주소 host는
// CONFIG다.
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

// TestMySQLTLSConnection은 make test-servers의 TLS server에
// ssl-mode=VERIFY_IDENTITY로 연결해 TLS를 요구하고, 다른 CA가 서명했거나 다른
// host를 이름으로 가진 인증서의 server를 거부한다.
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
			t.Fatalf("%s is required; run make test-servers", env)
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
