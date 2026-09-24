package ormgen

import (
	"context"
	"os"
	"testing"
)

// TestServerLiveIncrementalMigration runs the live migration cycle on MySQL and
// PostgreSQL. The MySQL CHECK constraint has the physical name
// ck_<table>_<name>; import returns the declared name, so an unchanged table
// has no diff.
func TestServerLiveIncrementalMigration(t *testing.T) {
	for _, tc := range []struct{ driver, env string }{
		{"mysql", "ORM_TOOLS_MYSQL_DSN"},
		{"postgres", "ORM_TOOLS_POSTGRES_DSN"},
	} {
		t.Run(tc.driver, func(t *testing.T) {
			dsn := os.Getenv(tc.env)
			if dsn == "" {
				t.Fatalf("%s is required; physical DB tests never skip", tc.env)
			}
			db, opened, err := openToolDB(dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if opened.dialect != tc.driver {
				t.Fatalf("%s names a %s database", tc.env, opened.dialect)
			}
			assertLiveIncrementalMigration(t, context.Background(), db, tc.driver)
		})
	}
}
