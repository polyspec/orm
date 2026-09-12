package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func compositeGeneratorManifest(t *testing.T) *schema.Manifest {
	t.Helper()
	diagram, err := schema.Parse(`erDiagram
  account {
    bigint tenant_id PK
    bigint id PK
    varchar(191) name
    int aes_key_version
    varchar(255) aes_hex_email "aes hex"
  }
  membership {
    bigint tenant_id PK,FK
    bigint account_id PK,FK
    varchar(191) role
  }
  account ||--o{ membership : "(tenant_id, account_id) (account / memberships) cascade"
`)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	return manifest
}

func TestCompositeKeyGenerationHasTheSameStructuresInEveryLanguage(t *testing.T) {
	manifest := compositeGeneratorManifest(t)
	dir := t.TempDir()
	tests := []struct {
		name      string
		gen       func(string) error
		file      string
		required  []string
		forbidden []string
	}{
		{"go", func(out string) error { return genGo(manifest, out) }, "membership.go", []string{
			"type MembershipKey struct", "TenantId  int64", "AccountId int64",
			`r.Mark("membership", []string{"tenant_id", "account_id"}, []any{r.TenantId, r.AccountId})`,
			"GetByTenantIdAndAccountId(v0 int64, v1 int64)", `MoveKeysToWhere([]string{"tenant_id", "account_id"})`,
		}, []string{`Mark("membership", "tenant_id"`}},
		{"php", func(out string) error { return genPHP(manifest, out, "App\\Orm") }, "Membership.php", []string{
			"final readonly class MembershipKey", "public int $tenantId", "public int $accountId", "primaryKeys(): array { return ['tenant_id', 'account_id']; }", "getByTenantIdAndAccountId(int $v0, int $v1)",
			"runSave($db, ['tenant_id', 'account_id'])",
		}, []string{"function pk(): string"}},
		{"rust", func(out string) error { return genRust(manifest, out) }, filepath.Join("src", "membership.rs"), []string{
			"pub struct MembershipKey", "pub tenant_id: i64", "pub account_id: i64", `PRIMARY_KEYS: &'static [&'static str] = &["tenant_id", "account_id"]`,
			"original_key: Option<Vec<Param>>", "get_by_tenant_id_and_account_id", `take_sets(&["tenant_id", "account_id"])`,
		}, []string{"original_key: Option<Param>"}},
		{"typescript", func(out string) error { return genTypeScript(manifest, out) }, "entities.ts", []string{
			"export interface MembershipKey", "readonly tenantId:number", "readonly accountId:number", "primaryKeys(): readonly string[] { return ['tenant_id','account_id']; }",
			"getByTenantIdAndAccountId(value0:number,value1:number)", "saveKeys(['tenant_id','account_id'])",
		}, []string{"primaryKey(): string"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			out := filepath.Join(dir, test.name)
			if err := test.gen(out); err != nil {
				t.Fatal(err)
			}
			body, err := os.ReadFile(filepath.Join(out, test.file))
			if err != nil {
				t.Fatal(err)
			}
			text := string(body)
			for _, required := range test.required {
				if !strings.Contains(text, required) {
					t.Errorf("missing %q", required)
				}
			}
			for _, forbidden := range test.forbidden {
				if strings.Contains(text, forbidden) {
					t.Errorf("contains first-key-only form %q", forbidden)
				}
			}
		})
	}
}
