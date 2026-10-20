package runtimemodel

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

const parentDocument = `dbspec 1 accounts

# Comments and diagrams do not remain in the manifest text.
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

// TestLoadRebuildsTheModelOfTheManifestText checks that reading the manifest text of a document set again
// gives the same manifestHash and entities.
// Requirements: DBS-100, DBS-103, DBS-111, DBS-112, DBS-114.
func TestLoadRebuildsTheModelOfTheManifestText(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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

// TestLoadRejectsInvalidManifestText rejects, with a diagnostic, text with no header and text in which the same document
// appears twice.
func TestLoadRejectsInvalidManifestText(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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

// TestLoadFilesRejectsFileWithoutSignature checks that a file with no signature (a DbSchema project XML,
// an empty file) is rejected, without parsing it, by a single SCHEMA_INVALID signature diagnostic.
func TestLoadFilesRejectsFileWithoutSignature(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, name := range []string{"dbschema.dbs", "empty.dbs"} {
		path := filepath.Join("..", "..", "..", "..", "tests", "dbspec", "files", name)
		_, err := LoadFiles(path)
		want := "SCHEMA_INVALID: 1:1 signature: " + path + " is not a dbspec document"
		if err == nil || err.Error() != want {
			t.Fatalf("LoadFiles(%s) = %v, want %s", name, err, want)
		}
	}
}
