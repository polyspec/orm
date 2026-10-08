//go:build featurecoverage

package model_test

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/orm-go/model"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

// TestCoverageSchemaInstallExisting는 generated model이 품은 bench manifest를
// 이미 설치된 database에 다시 설치하면 성공하고 아무것도 바꾸지 않는지
// 확인한다.
func TestCoverageSchemaInstallExisting(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	before := must(model.Author().Connect(db).GetCount())
	if err := db.Utils().Schema().Install(model.Schema); err != nil {
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
	testcase.Start(t, testcase.Database)
	db, driver, dsn := connectFeature(t)
	m, diagnostics := runtimemodel.LoadDocuments([]string{partialDocument})
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	if nativeTableExists(t, driver, dsn, "coverage_install_missing") {
		t.Fatal("table coverage_install_missing exists before the install")
	}
	if err := db.Utils().Schema().Install(&orm.Schema{Hash: m.ManifestHash, Text: m.ManifestText}); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("install of a partly installed set = %v, want CONFIG", err)
	}
	if nativeTableExists(t, driver, dsn, "coverage_install_missing") {
		t.Fatal("the rejected install created table coverage_install_missing")
	}
}

// externalUser는 bench database의 table user를 외부 문서로 쓰는 document set의
// 외부 문서다. drift는 database에 없는 column을 더한다.
const externalUser = `dbspec 1 bench_user

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}
`

// externalMember는 externalUser의 user를 쓰고 coverage_external_post만 소유한다.
const externalMember = `dbspec 1 coverage_external

use bench_user { user }

table coverage_external_post {
  seq i64 identity
  user_seq i64
  primary key (seq)
  index ix_coverage_external_post_user (user_seq)
  foreign key fk_coverage_external_post_user (user_seq) references user (seq)
}
`

// TestCoverageSchemaInstallExternalDocuments는 외부 문서를 쓰는 set의 install이 외부
// table을 database에서 확인하는지 본다. 같은 table이면 연결하고, 외부 문서의 column이
// database에 없으면 install이 CONFIG이며 소유한 table을 만들지 않는다. 등록은 database를
// 읽지 않으므로 그 set으로도 연결한다.
func TestCoverageSchemaInstallExternalDocuments(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, driver, dsn := connectFeature(t)
	schema := func(external string) *orm.Schema {
		m, diagnostics := runtimemodel.LoadDocumentSet([]string{externalMember}, []string{external})
		if len(diagnostics) > 0 {
			t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
		}
		return &orm.Schema{Hash: m.ManifestHash, Text: m.ManifestText, External: m.ExternalText}
	}
	member := schema(externalUser)
	connected, err := orm.ConnectSchema(dsn, member, orm.Config{})
	if err != nil {
		t.Fatalf("connect of a set whose external table user matches the database: %v", err)
	}
	if err := connected.Close(); err != nil {
		t.Fatal(err)
	}
	drifted := schema(strings.Replace(externalUser, "  name varchar(191)\n", "  name varchar(191)\n  coverage_missing varchar(8) null\n", 1))
	want := "the tables that the set uses from external documents differ from the database: column user.coverage_missing does not exist"
	connected, err = orm.ConnectSchema(dsn, drifted, orm.Config{})
	if err != nil {
		t.Fatalf("connect with a drifted external table: %v, want a connection that reads nothing", err)
	}
	if err := connected.Close(); err != nil {
		t.Fatal(err)
	}
	if err := db.Utils().Schema().Install(drifted); orm.ErrorCode(err) != orm.CodeConfig || !strings.Contains(err.Error(), want) {
		t.Fatalf("install with a drifted external table = %v, want CONFIG with %q", err, want)
	}
	if nativeTableExists(t, driver, dsn, "coverage_external_post") {
		t.Fatal("the rejected install created table coverage_external_post")
	}
}
