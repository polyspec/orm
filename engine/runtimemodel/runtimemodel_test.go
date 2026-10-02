package runtimemodel

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const parentDocument = `dbspec 1 accounts

# 주석과 diagram은 manifest text에 남지 않는다.
table tenant {
  id i64 identity
  name varchar(50)
  primary key (id)
}

diagram main {
  tenant at 0 0
}
`

const childDocument = `dbspec 1 members

use accounts { tenant }

table member_row {
  id i64 identity
  tenant_id i64
  note text
  secret bytes null
  aes_key_version i32
  updated_at datetime(6) default now
  deleted_at datetime(6) null
  primary key (id)
  index ix_member_tenant (tenant_id)
  foreign key fk_member_tenant (tenant_id) references tenant (id) on delete restrict on update restrict
  settings {
    entity member
    updated updated_at
    soft_delete deleted_at
    select explicit aes_key_version
    codec secret ordered_json aes
    aes_version aes_key_version
  }
}
`

// TestLoadRebuildsTheModelOfTheManifestText는 document set의 manifest text를
// 다시 읽으면 같은 manifestHash와 entity가 나오는지 확인한다.
func TestLoadRebuildsTheModelOfTheManifestText(t *testing.T) {
	built, diagnostics := LoadDocuments([]string{childDocument, parentDocument})
	if len(diagnostics) > 0 {
		t.Fatal(DiagnosticsError(diagnostics))
	}
	if strings.Contains(built.ManifestText, "#") || strings.Contains(built.ManifestText, "diagram") || !strings.HasPrefix(built.ManifestText, "dbspec 1 accounts\n") {
		t.Fatalf("manifest text = %q", built.ManifestText)
	}
	loaded, diagnostics := Load(built.ManifestText)
	if len(diagnostics) > 0 {
		t.Fatal(DiagnosticsError(diagnostics))
	}
	if loaded.ManifestHash != built.ManifestHash || !strings.HasPrefix(loaded.ManifestHash, "sha256:") || !slices.Equal(loaded.Order, []string{"tenant", "member"}) {
		t.Fatalf("loaded %s %v, built %s", loaded.ManifestHash, loaded.Order, built.ManifestHash)
	}
	member := loaded.Entities["member"]
	if member.Table != "member_row" || member.Identity != "id" || member.Updated != "updated_at" || member.SoftDelete != "deleted_at" || member.AESVersion != "aes_key_version" {
		t.Fatalf("member entity = %+v", member)
	}
	if f := member.Field("secret"); !f.Styled() || !f.Encrypted() || !f.Null || f.Type != "bytes" {
		t.Fatalf("secret field = %+v", f)
	}
	if !member.Field("aes_key_version").SelectExplicit || member.Field("note").SelectExplicit || !member.Field("tenant_id").ForeignKey || !member.Field("updated_at").Default {
		t.Fatalf("member fields = %+v", member.Fields)
	}
}

// TestLoadRejectsInvalidManifestText는 header 없는 text와 같은 document가 두
// 번 있는 text를 diagnostic으로 거부한다.
func TestLoadRejectsInvalidManifestText(t *testing.T) {
	for text, rule := range map[string]string{
		"":                              "header",
		"table x {\n}\n":                "header",
		parentDocument + parentDocument: "name.duplicate",
	} {
		if _, diagnostics := Load(text); len(diagnostics) == 0 || diagnostics[0].Rule != rule {
			t.Errorf("Load(%q) = %v, want %s", text, diagnostics, rule)
		}
	}
}

// TestLoadFilesRejectsFileWithoutSignature는 signature가 없는 파일(DbSchema project XML,
// 빈 파일)을 parse하지 않고 SCHEMA_INVALID signature diagnostic 하나로 거부하는지 확인한다.
func TestLoadFilesRejectsFileWithoutSignature(t *testing.T) {
	for _, name := range []string{"dbschema.dbs", "empty.dbs"} {
		path := filepath.Join("..", "..", "tests", "dbspec", "files", name)
		_, err := LoadFiles(path)
		want := "SCHEMA_INVALID: 1:1 signature: " + path + " is not a dbspec document"
		if err == nil || err.Error() != want {
			t.Fatalf("LoadFiles(%s) = %v, want %s", name, err, want)
		}
	}
}
