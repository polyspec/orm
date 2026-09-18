//go:build physical

package ormgen

import (
	"context"
	"os"
	"testing"
)

func TestPhysicalAudit(t *testing.T) {
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
			assertAuditCycle(t, context.Background(), db, tc.driver)
		})
	}
}

func TestPhysicalSchemaFeatures(t *testing.T) {
	for _, tc := range []struct{ driver, env string }{
		{"mysql", "ORM_TOOLS_MYSQL_DSN"},
		{"postgres", "ORM_TOOLS_POSTGRES_DSN"},
	} {
		t.Run(tc.driver, func(t *testing.T) {
			dsn := os.Getenv(tc.env)
			if dsn == "" {
				t.Fatalf("%s is required; physical DB tests never skip", tc.env)
			}
			db, _, err := openToolDB(dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			assertSchemaFeatures(t, context.Background(), db, tc.driver)
		})
	}
}
