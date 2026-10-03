//go:build featurecoverage

package model_test

import (
	"database/sql"
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

// featureDatabase는 feature coverage checker가 고른 database와 DSN이다.
// 둘 중 하나라도 없으면 test가 실패한다.
func featureDatabase(t *testing.T) (string, string) {
	t.Helper()
	driver, dsn := os.Getenv("ORM_FEATURE_DATABASE"), os.Getenv("ORM_FEATURE_DSN")
	if dsn == "" || (driver != "mysql" && driver != "postgres" && driver != "sqlite") {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) and ORM_FEATURE_DSN are required")
	}
	return driver, dsn
}

// connectFeature는 고른 seed bench database에 generated model로 연결한다.
// AES와 blind index key는 seed가 쓴 key다.
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

// nativeTableExists는 native driver로 연결의 현재 database나 schema에 table이
// 있는지 읽는다.
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
