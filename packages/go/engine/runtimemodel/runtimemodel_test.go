package runtimemodel

import (
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
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

const loadSetOwned = "dbspec 1 shop\n\nuse core { account }\n\ntable item {\n  seq i64\n  account_seq i64\n  primary key (seq)\n  index ix_item_account (account_seq)\n  foreign key fk_item_account (account_seq) references account (seq) on delete restrict on update restrict\n}\n"
const loadSetExternal = "dbspec 1 core\n\ntable account {\n  seq i64\n  primary key (seq)\n}\n"

// Requirements: DBS-156, SCH-12.
func TestLoadSetReturnsExternalDocumentsMarked(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	model, diagnostics := LoadSet(loadSetOwned, loadSetExternal)
	if len(diagnostics) > 0 {
		t.Fatal(DiagnosticsError(diagnostics))
	}
	if len(model.Documents) != 2 || model.Documents[0].Name != "shop" || model.Documents[0].External || model.Documents[1].Name != "core" || !model.Documents[1].External {
		got := make([]string, len(model.Documents))
		for i, document := range model.Documents {
			got[i] = document.Name + ":external=" + strconv.FormatBool(document.External)
		}
		t.Fatalf("documents = %v, want [shop:external=false core:external=true]", got)
	}
	withoutExternal, diagnostics := LoadSet(loadSetExternal, "")
	if len(diagnostics) > 0 {
		t.Fatal(DiagnosticsError(diagnostics))
	}
	if len(withoutExternal.Documents) != 1 || withoutExternal.Documents[0].Name != "core" || withoutExternal.Documents[0].External {
		t.Fatalf("documents without external text = %+v, want core owned", withoutExternal.Documents)
	}
	if _, diagnostics := LoadSet("table item {}\n", loadSetExternal); len(diagnostics) == 0 || diagnostics[0].Rule != dbspec.RuleHeader {
		t.Fatalf("LoadSet without a manifest header = %v, want header diagnostic", diagnostics)
	}
	if _, diagnostics := LoadSet(loadSetOwned, "table account {}\n"); len(diagnostics) == 0 || diagnostics[0].Rule != dbspec.RuleHeader {
		t.Fatalf("LoadSet with external text without a header = %v, want header diagnostic", diagnostics)
	}
}

// TestLoadRebuildsTheModelOfTheManifestText checks that reading the manifest text of a document set again
// gives the same manifestHash and entities.
// Requirements: DBS-104, DBS-111, DBS-120.
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
// Requirements: DBS-4, DBS-155.
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
