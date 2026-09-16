package ormgen

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/engine/schema"
	_ "modernc.org/sqlite"
)

func TestSQLiteCompositeSchemaRoundTripAndCascadeAreIdempotent(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "composite.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys=ON"); err != nil {
		t.Fatal(err)
	}
	want := buildCompositeMigrationManifest(t, `erDiagram
  composite_account {
    bigint tenant_id PK
    bigint id PK
  }
  composite_membership {
    bigint tenant_id PK,FK
    bigint account_id PK,FK
    varchar(191) role
  }
  composite_account ||--o{ composite_membership : "(tenant_id, account_id) (account / memberships) cascade"
`)
	ddl, err := renderCreateDDL(want, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := executeMigration(ctx, db, "sqlite", ddl); err != nil {
			t.Fatalf("application %d: %v\n%s", i+1, err, ddl)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO "composite_account" ("tenant_id","id") VALUES (7,11)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO "composite_membership" ("tenant_id","account_id","role") VALUES (7,11,'owner')`); err != nil {
		t.Fatal(err)
	}
	live, err := liveManifest(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	entity := live.Entities["composite_membership"]
	if entity == nil || len(entity.PK) != 2 || entity.PK[0] != "tenant_id" || entity.PK[1] != "account_id" {
		t.Fatalf("primary key differs: %#v", entity)
	}
	var relation *schema.Rel
	for _, candidate := range entity.Relations {
		if candidate.Target == "composite_account" {
			relation = candidate
			break
		}
	}
	if relation == nil || relation.OnDelete != "cascade" || len(relation.Keys) != 2 || relation.Keys[0] != (schema.RelKey{Local: "tenant_id", Target: "tenant_id"}) || relation.Keys[1] != (schema.RelKey{Local: "account_id", Target: "id"}) {
		t.Fatalf("foreign key differs: %#v", relation)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM "composite_account" WHERE "tenant_id"=7 AND "id"=11`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM "composite_membership"`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("cascade count=%d err=%v", count, err)
	}
}

func buildCompositeMigrationManifest(t *testing.T, source string) *schema.Manifest {
	t.Helper()
	diagram, err := schema.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	return manifest
}
