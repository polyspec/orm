// Requirements: INT-101.

package orm_test

import (
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCatalogTemporalPrecisionLimit is the one rule of catalog_connection that the recipe cannot state: the MySQL server
// refuses a TIME(7) (INT-101, DIA-54). The recipe's sql.exec step cannot assert a server error, since the runner matches
// only errors that carry an engine code, so this native check stays in the runtimes that run it (FCV-2, the catalog
// connection exclusions of docs/spec/feature-coverage.md). It takes its MySQL database from ORM_TEST_MYSQL_DSN, as the
// recipe entries do.
func TestCatalogTemporalPrecisionLimit(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := os.Getenv("ORM_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers")
	}
	raw := openRaw(t, "mysql", dsn)
	defer testcase.Close(t, raw)
	_, err := raw.Exec("CREATE TABLE catalog_precision_invalid (id BIGINT PRIMARY KEY, t TIME(7))")
	if err == nil {
		if _, dropErr := raw.Exec("DROP TABLE catalog_precision_invalid"); dropErr != nil {
			t.Errorf("drop unexpectedly accepted precision table: %v", dropErr)
		}
		t.Fatal("mysql accepted temporal precision 7")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "precision") {
		t.Fatalf("mysql precision 7 failed for another reason: %v", err)
	}
}
