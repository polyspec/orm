//go:build featurecoverage

package model_test

import (
	"testing"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine/runtimemodel"
)

// TestCoverageSchemaInstallExisting는 generated model이 품은 bench manifest를
// 이미 설치된 database에 다시 설치하면 성공하고 아무것도 바꾸지 않는지
// 확인한다.
func TestCoverageSchemaInstallExisting(t *testing.T) {
	db, _, _ := connectFeature(t)
	before := must(model.Author().Connect(db).GetCount())
	if err := db.Utils().Schema().Install(model.ManifestText); err != nil {
		t.Fatalf("install of the installed bench manifest: %v", err)
	}
	if after := must(model.Author().Connect(db).GetCount()); after != before || after != 100000 {
		t.Fatalf("author count %d -> %d, want 100000", before, after)
	}
}

// partialDocument는 table user만 bench database에 있는 document다.
const partialDocument = `dbspec 1 partial

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}

table coverage_install_missing {
  seq i64 identity
  primary key (seq)
}
`

// TestCoverageSchemaInstallPartial는 table 일부만 있는 document set의 install이
// CONFIG이고 없는 table을 만들지 않는지 확인한다.
func TestCoverageSchemaInstallPartial(t *testing.T) {
	db, driver, dsn := connectFeature(t)
	m, diagnostics := runtimemodel.LoadDocuments([]string{partialDocument})
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	if nativeTableExists(t, driver, dsn, "coverage_install_missing") {
		t.Fatal("table coverage_install_missing exists before the install")
	}
	if err := db.Utils().Schema().Install(m.ManifestText); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("install of a partly installed set = %v, want CONFIG", err)
	}
	if nativeTableExists(t, driver, dsn, "coverage_install_missing") {
		t.Fatal("the rejected install created table coverage_install_missing")
	}
}
