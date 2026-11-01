//go:build featurecoverage

package model_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageSchemaInstallExisting checks that the bench manifest of the generated model installs into a database where
// it is already installed and changes nothing. The schema installation cases themselves are the recipe
// contracts/fixtures/schema_install/schema_install.json, which every runtime runs (FCV-2); only the bench model, which the
// generated Go model alone holds, is tested here.
// Requirements: SCH-16, SCH-7, DBS-108, PLN-44, INT-55.
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
