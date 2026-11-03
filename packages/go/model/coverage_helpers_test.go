//go:build featurecoverage

package model_test

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
)

// featureDatabase is the database and DSN that the feature coverage checker chose.
// If either one is missing, the test fails.
func featureDatabase(t *testing.T) (string, string) {
	t.Helper()
	return testdb.FeatureDatabase(t)
}

// connectFeature connects to the chosen seed bench database with the generated model.
// The AES and blind index keys are the keys the seed wrote.
func connectFeature(t *testing.T) (*orm.DB, string, string) {
	t.Helper()
	driver, dsn := featureDatabase(t)
	db, err := model.Connect(dsn, orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	if db.Driver() != driver {
		t.Fatalf("connected to %s, want %s", db.Driver(), driver)
	}
	return db, driver, dsn
}

// nativeTableExists uses the native driver to read whether a table exists in the
// current database or schema of the connection.
func nativeTableExists(t *testing.T, driver, dsn, table string) bool {
	t.Helper()
	var raw *sql.DB
	query := map[string]string{
		"mysql":    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
		"postgres": "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1",
		"sqlite":   "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
	}[driver]
	if driver == "sqlite" {
		path, _, _ := strings.Cut(strings.TrimPrefix(dsn, "sqlite://"), "?")
		var err error
		if raw, err = sql.Open("sqlite", path); err != nil {
			t.Fatal(err)
		}
	} else {
		raw = openNative(t, driver, dsn)
	}
	defer func() {
		if err := raw.Close(); err != nil {
			t.Error(err)
		}
	}()
	var n int
	if err := raw.QueryRow(query, table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n > 0
}

// removeTenantAccounts deletes the composite_account rows of the tenant that a failed case left
// behind. Memberships are deleted along with them through ON DELETE CASCADE. If any row was deleted,
// the case did not finish its cleanup, so it reports failure.
func removeTenantAccounts(t *testing.T, db *orm.DB, tenant int64) {
	t.Helper()
	rows, err := model.CompositeAccount().Connect(db).TenantId(tenant).Gets()
	if err != nil {
		t.Errorf("read tenant %d accounts for cleanup: %v", tenant, err)
		return
	}
	if rows.Len() == 0 {
		return
	}
	t.Errorf("tenant %d left %d composite_account rows; removing them", tenant, rows.Len())
	if err := rows.Delete(); err != nil {
		t.Errorf("remove tenant %d accounts: %v", tenant, err)
	}
}
