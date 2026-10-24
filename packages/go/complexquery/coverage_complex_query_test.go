//go:build featurecoverage

package complexquery

import (
	"testing"

	"github.com/polyspec/orm/packages/go/complexmodel"
	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageComplexQueryProductSearch runs the Product search against the
// fixture database selected by the feature coverage runner.
func TestCoverageComplexQueryProductSearch(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, dsn := testdb.FeatureDatabase(t)
	db, err := complexmodel.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	assertComplexSearch(t, db, driver, readComplexFixture(t))
}
