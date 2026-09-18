package schema

import (
	"strings"
	"testing"
)

func mustBuild(t *testing.T, src string) *Manifest {
	t.Helper()
	d, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	m, err := Build(d)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestBuildExample(t *testing.T) {
	m := mustBuild(t, ml(example+`
  service { bigint seq PK "auto" }
  user { bigint seq PK "auto" }
`))
	b := m.Entities["battle"]
	if b.Auto != "seq" || b.PK[0] != "seq" {
		t.Fatalf("pk/auto: %+v", b)
	}
	c := b.Column("is_close")
	if c.Type != "bool" || *c.Default != "0" {
		t.Errorf("is_close: %+v", c)
	}
	if c := b.Column("description"); c.Type != "text" || !c.Lazy || !c.Nullable {
		t.Errorf("description: %+v", c)
	}
	if c := b.Column("aes_key_version"); c == nil || c.Type != "i32" || c.Nullable || !c.Lazy {
		t.Errorf("aes_key_version: %+v", c)
	}
	if c := b.Column("aes_key_version"); c != nil && len(c.Styles) != 0 {
		t.Errorf("aes_key_version must not be an AES payload column: %+v", c.Styles)
	}
	if c := b.Column("aes_hex_email"); c.Type != "string" || c.Len != 255 || c.Lazy || strings.Join(c.Styles, ",") != "aes,hex" {
		t.Errorf("aes_hex_email: %+v", c)
	}
	if c := b.Column("serialize_files"); c.Type != "text" || !c.Lazy || strings.Join(c.Styles, ",") != "serialize" {
		t.Errorf("serialize_files: %+v", c)
	}
	if c := b.Column("upload_archive"); c.Type != "text" || !c.Lazy || strings.Join(c.Styles, ",") != "serialize,base64" {
		t.Errorf("upload_archive: %+v", c)
	}
	if c := b.Column("yaml_settings"); c.Type != "text" || !c.Lazy || strings.Join(c.Styles, ",") != "yaml" {
		t.Errorf("yaml_settings: %+v", c)
	}
	if c := b.Column("ip"); c.Type != "inet" || c.Lazy {
		t.Errorf("ip: %+v", c)
	}
	if c := b.Column("review_star"); c.Type != "decimal" || c.Precision != 13 || c.Scale != 3 {
		t.Errorf("review_star: %+v", c)
	}
	if c := b.Column("updated_user_seq"); c.Ref == nil || c.Ref.Entity != "user" || !c.FK {
		t.Errorf("updated_user_seq: %+v", c)
	}
	if c := b.Column("user_seq"); c.Ref != nil {
		t.Errorf("user_seq should have no ref (no line, no ->): %+v", c)
	}
	// relations: derived names
	if r := b.Relations["service"]; r == nil || r.Kind != "one" || len(r.Keys) != 1 || r.Keys[0].Local != "service_seq" || r.Keys[0].Target != "seq" || r.Target != "service" {
		t.Errorf("battle.service: %+v", r)
	}
	if r := m.Entities["service"].Relations["battles"]; r == nil || r.Kind != "many" || len(r.Keys) != 1 || r.Keys[0].Local != "seq" || r.Keys[0].Target != "service_seq" {
		t.Errorf("service.battles: %+v", r)
	}
	if r := b.Relations["updater"]; r == nil || r.OnDelete != "cascade" {
		t.Errorf("battle.updater: %+v", r)
	}
	if r := m.Entities["user"].Relations["updated_battles"]; r == nil {
		t.Errorf("user.updated_battles missing")
	}
	if r := b.Relations["items"]; r == nil || r.Kind != "many" || r.Target != "battle_item" {
		t.Errorf("battle.items: %+v", r)
	}
	if r := m.Entities["battle_item"].Relations["battle"]; r == nil || r.Kind != "one" {
		t.Errorf("battle_item.battle: %+v", r)
	}
	if len(b.Unique) != 2 || b.Indexes["ik"][1] != "is_close" || b.Fulltext[0][1] != "description" {
		t.Errorf("unique/index/fulltext: %+v %+v %+v", b.Unique, b.Indexes, b.Fulltext)
	}
	if b.Timestamps.Created != "created_ts" || b.Timestamps.Updated != "updated_ts" {
		t.Errorf("timestamps: %+v", b.Timestamps)
	}
	if len(m.SchemaHash) != 16 {
		t.Errorf("hash: %q", m.SchemaHash)
	}
	// warnings: FK columns without a relationship line or '->'
	w := m.Warnings()
	if len(w) != 2 || !strings.Contains(w[0], "battle.user_seq") || !strings.Contains(w[1], "battle.game_group_seq") {
		t.Errorf("warnings: %v", w)
	}
	// round trip through JSON and hand-edit detection
	js, _ := m.MarshalIndent()
	m2, err := Load(js)
	if err != nil || m2.SchemaHash != m.SchemaHash {
		t.Fatalf("load: %v", err)
	}
	if _, err := Load([]byte(strings.Replace(string(js), `"lazy": true`, `"lazy": false`, 1))); err == nil {
		t.Error("hand-edited schema.json must be rejected")
	}
}

func TestBuildUUIDColumn(t *testing.T) {
	m := mustBuild(t, "erDiagram\n  item {\n    uuid id PK\n  }\n")
	c := m.Entities["item"].Column("id")
	if c.Type != "string" || c.Raw != "uuid" {
		t.Fatalf("uuid column = %+v, want string binding with uuid raw type", c)
	}
}

func TestBuildAllowsNonSeqPrimaryKey(t *testing.T) {
	m := mustBuild(t, "erDiagram\n  account {\n    varchar(36) account_uuid PK\n    varchar(191) name\n  }\n")
	if len(m.Entities["account"].PK) != 1 || m.Entities["account"].PK[0] != "account_uuid" {
		t.Fatalf("non-seq primary key was not preserved: %#v", m.Entities["account"].PK)
	}
}

func TestSoftDeleteDirectiveStoresValidatedColumn(t *testing.T) {
	m := mustBuild(t, "erDiagram\n account {\n bigint id PK\n datetime deleted_at \"?\"\n }\n %% soft_delete account deleted_at\n")
	if got := m.Entities["account"].SoftDelete; got != "deleted_at" {
		t.Fatalf("soft delete column = %q, want deleted_at", got)
	}
}

func TestSoftDeleteDirectiveRejectsInvalidColumns(t *testing.T) {
	for name, src := range map[string]string{
		"unknown": `erDiagram
 account {
 bigint id PK
 }
 %% soft_delete account missing
`,
		"non-null": `erDiagram
 account {
 bigint id PK
 datetime deleted_at
 }
 %% soft_delete account deleted_at
`,
		"wrong-type": `erDiagram
 account {
 bigint id PK
 varchar(32) deleted_at "?"
 }
 %% soft_delete account deleted_at
`,
		"duplicate": `erDiagram
 account {
 bigint id PK
 datetime deleted_at "?"
 }
 %% soft_delete account deleted_at
 %% soft_delete account deleted_at
`,
	} {
		t.Run(name, func(t *testing.T) {
			d, err := Parse(src)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Build(d); err == nil {
				t.Fatal("invalid soft-delete declaration was accepted")
			}
		})
	}
}

func TestAllowedColumnNames(t *testing.T) {
	for _, n := range []string{"order_number", "condition_type", "withdraw_count", "android_app_url", "origin_price", "brand_name", "seq_no", "is_win", "key", "order", "group", "select", "name_like", "min_price"} {
		if err := CheckColumnName(n); err != nil {
			t.Errorf("%s should be allowed: %v", n, err)
		}
	}
	for _, n := range []string{"terms_and_conditions", "a_or_b", "x_with_y", "price_gt", "get_dt", "order_by_x", "random", "create", "or", "a__b", "CamelCase", "1x"} {
		if err := CheckColumnName(n); err == nil {
			t.Errorf("%s should be rejected", n)
		}
	}
}

func TestRenameDirectivesEnterManifest(t *testing.T) {
	m := mustBuild(t, "erDiagram\n customer {\n bigint id PK\n varchar(40) display_name\n }\n %% rename_table customer account\n %% rename_column customer display_name name\n")
	if m.Entities["customer"].RenamedFrom != "account" || m.Entities["customer"].Column("display_name").RenamedFrom != "name" {
		t.Fatalf("rename metadata missing: %#v", m.Entities["customer"])
	}
}

func TestRenameDirectivesRejectAmbiguousSources(t *testing.T) {
	cases := []string{
		"erDiagram\n account {\n bigint id PK\n }\n %% rename_table account account\n",
		"erDiagram\n first {\n bigint id PK\n }\n second {\n bigint id PK\n }\n %% rename_table first account\n %% rename_table second account\n",
		"erDiagram\n account {\n bigint id PK\n varchar(20) first_name\n varchar(20) display_name\n }\n %% rename_column account first_name name\n %% rename_column account display_name name\n",
		"erDiagram\n account {\n bigint id PK\n varchar(20) name\n varchar(20) display_name\n }\n %% rename_column account display_name name\n",
	}
	for _, src := range cases {
		d, err := Parse(src)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Build(d); err == nil || !strings.Contains(err.Error(), "rename") {
			t.Fatalf("expected rename validation error, got %v", err)
		}
	}
}

func TestCompositePrimaryAndForeignKeysPreserveOrderedPairs(t *testing.T) {
	diagram, err := Parse("erDiagram\n account {\n bigint tenant_id PK\n bigint id PK\n }\n membership {\n bigint tenant_id PK, FK\n bigint account_id PK, FK\n }\n account ||--o{ membership : \"(tenant_id, account_id) (account / memberships) cascade\"\n")
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	relation := manifest.Entities["membership"].Relations["account"]
	if relation == nil || relation.Kind != "one" || relation.Target != "account" || relation.OnDelete != "cascade" || len(relation.Keys) != 2 || relation.Keys[0].Local != "tenant_id" || relation.Keys[0].Target != "tenant_id" || relation.Keys[1].Local != "account_id" || relation.Keys[1].Target != "id" {
		t.Fatalf("composite child relation differs: %#v", relation)
	}
	reverse := manifest.Entities["account"].Relations["memberships"]
	if reverse == nil || len(reverse.Keys) != 2 || reverse.Keys[0].Local != "tenant_id" || reverse.Keys[0].Target != "tenant_id" || reverse.Keys[1].Local != "id" || reverse.Keys[1].Target != "account_id" {
		t.Fatalf("composite parent relation differs: %#v", reverse)
	}
}

func TestBlindIndexDirectiveRequiresDedicatedIndexedColumn(t *testing.T) {
	good := "erDiagram\n account {\n bigint id PK\n int aes_key_version \"=1\"\n varchar(255) aes_email \"? aes\"\n char(64) email_index \"?\"\n }\n %% index account (email_index) email_index_idx\n %% blind_index account aes_email email_index\n"
	m := mustBuild(t, good)
	if got := m.Entities["account"].Column("aes_email").BlindIndex; got != "email_index" {
		t.Fatalf("blind index = %q", got)
	}
	for _, src := range []string{
		"erDiagram\n account {\n bigint id PK\n int aes_key_version \"=1\"\n varchar(255) aes_email \"? aes\"\n varchar(32) email_index\n }\n %% blind_index account aes_email email_index\n",
		"erDiagram\n account {\n bigint id PK\n int aes_key_version \"=1\"\n varchar(255) aes_email \"? aes\"\n bigint email_index\n }\n %% blind_index account aes_email email_index\n",
		"erDiagram\n account {\n bigint id PK\n int aes_key_version \"=1\"\n varchar(255) aes_email \"? aes\"\n char(64) email_index\n varchar(30) name\n }\n %% blind_index account name email_index\n",
	} {
		d, err := Parse(src)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Build(d); err == nil || !strings.Contains(err.Error(), "blind index") {
			t.Fatalf("expected blind index validation error, got %v", err)
		}
	}
}

// ml expands one-line entity blocks used for brevity in tests into the
// multi-line form the parser (and Mermaid) require.
func ml(src string) string {
	src = strings.ReplaceAll(src, " { ", " {\n ")
	src = strings.ReplaceAll(src, " }", "\n }")
	return src
}

func TestBuildErrors(t *testing.T) {
	cases := map[string]string{
		"erDiagram\n a { bigint x }":                                                "has no PK",
		"erDiagram\n a { bigint seq PK \"auto\"\n bigint seq PK }":                  "duplicate column",
		"erDiagram\n a { bigint seq PK \"auto\" }\n b ||--o{ a : x_seq":             "unknown entity b",
		"erDiagram\n a { bigint seq PK }\n b { bigint seq PK }\n b ||--o{ a : nope": "FK column nope not in a",
		"erDiagram\n a { bigint seq PK }\n b { bigint seq PK }\n b ||--o{ a : seq":  "cannot derive a name",
		"erDiagram\n a { bigint seq PK\n bigint b_seq FK\n bigint owner_b_seq FK }\n b { bigint seq PK }\n b ||--o{ a : b_seq\n b ||--o{ a : owner_b_seq": "already used",
		"erDiagram\n a { bigint seq PK \"-> zz.seq\" }":                                                             "target does not exist",
		"erDiagram\n a { bigint seq PK }\n %% index a (nope)":                                                       "unknown column nope",
		"erDiagram\n connect { bigint seq PK }":                                                                     "reserved by the generated models",
		"erDiagram\n a { bigint seq PK\n varchar(32) random }":                                                      "reserved method name",
		"erDiagram\n a { bigint seq PK\n bigint item FK }\n b { bigint seq PK }\n b ||--o{ a : \"item (item / x)\"": "collides with a column",
		"erDiagram\n a { whatever seq PK }":                                                                         "unsupported type",
		"erDiagram\n a { bigint seq PK\n varchar name }":                                                            "varchar requires a positive length",
		"erDiagram\n a { bigint seq PK\n varchar(0) name }":                                                         "varchar requires a positive length",
		"erDiagram\n a { bigint seq PK\n char code }":                                                               "char requires a positive length",
	}
	for src, want := range cases {
		d, err := Parse(ml(src))
		if err == nil {
			_, err = Build(d)
		}
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q:\n got %v\n want %q", src, err, want)
		}
	}
}

func TestAESVersionDirectiveFeedsManifest(t *testing.T) {
	d, err := Parse("erDiagram\n account {\n bigint seq PK\n int revision \"=1\"\n varchar(255) secret \"aes\"\n }\n %% aes_version account revision\n")
	if err != nil {
		t.Fatal(err)
	}
	m, err := Build(d)
	if err != nil {
		t.Fatal(err)
	}
	if got := m.Entities["account"].AESVersion; got != "revision" {
		t.Fatalf("AES version column=%q, want revision", got)
	}
}
