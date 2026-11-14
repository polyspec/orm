package model_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/model"
	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestCoverageSchemaInstallExisting checks that the bench manifest of the generated model installs into a database where
// it is already installed and changes nothing. The schema installation cases themselves are the recipe
// contracts/fixtures/schema_install/schema_install.json, which every runtime runs (FCV-2); only the bench model, which the
// generated Go model alone holds, is tested here.
// Requirements: SCH-16, SCH-7, DBS-108, PLN-44, INT-55.
func TestCoverageSchemaInstallExisting(t *testing.T) {
	testcase.Start(t)
	each(t, func(t *testing.T, db *orm.DB) {
		seed(t, db)
		before := must(model.Author().Connect(db).GetCount())
		if before == 0 {
			t.Fatal("the seed wrote no author")
		}
		if err := db.Utils().Schema().Install(model.Schema); err != nil {
			t.Fatalf("install of the installed bench manifest: %v", err)
		}
		if after := must(model.Author().Connect(db).GetCount()); after != before {
			t.Fatalf("author count %d -> %d", before, after)
		}
	})
}
