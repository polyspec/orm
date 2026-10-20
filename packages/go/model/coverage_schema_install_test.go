//go:build featurecoverage

package model_test

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageSchemaInstallExisting checks that the bench manifest contained in the generated model
// installs successfully and changes nothing when reinstalled into a database
// where it is already installed.
// Requirements: SCH-7, DBS-108.
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

// partialDocument is the document whose only table, user, is in the bench database.
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

// TestCoverageSchemaInstallPartial checks that installing a document set with only some of its tables
// is CONFIG and does not create the missing tables.
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

// externalUser is the document for table user of the bench database, used by a document set that
// treats it as an external document. drift adds a column that the database does not have.
const externalUser = `dbspec 1 bench_user

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}
`

// externalMember uses externalUser's user and owns only coverage_external_post.
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

// TestCoverageSchemaInstallExternalDocuments checks whether the install of a set that uses external documents
// sees the external table in the database. If it is the same table, it links; if an external document's column
// is not in the database, the install is CONFIG and does not create the table it owns. Registration does not
// read the database, so it links with that set too.
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
