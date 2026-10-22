//go:build featurecoverage

package orm_test

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// catalog_connection coverage: runs the two shared cases against the bench database that the feature check selected
// (ORM_FEATURE_DATABASE and ORM_FEATURE_DSN). The read case only reads; the mutation case inserts, updates and deletes
// one row of composite_account in tenant 990005 and ends in the state it started in.
const catalogTenant = 990005

func catalogConnect(t *testing.T) (string, *orm.CatalogConnection) {
	t.Helper()
	driver := os.Getenv("ORM_FEATURE_DATABASE")
	if !slices.Contains([]string{"mysql", "postgres", "sqlite"}, driver) {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run it through make feature-check, which sets it for each coverage case")
	}
	dsn := os.Getenv("ORM_FEATURE_DSN")
	c, err := orm.ConnectCatalog(dsn)
	if err != nil {
		t.Fatalf("%s: catalog connection: %v", driver, err)
	}
	if c.Dialect() != driver {
		t.Fatalf("ORM_FEATURE_DSN selects %s, not %s", c.Dialect(), driver)
	}
	return driver, c
}

func catalogQuote(name, driver string) string {
	if driver == "mysql" {
		return "`" + name + "`"
	}
	return `"` + name + `"`
}

// Requirements: SCH-5, SCH-6a.
func TestCoverageCatalogRead(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer c.Close()

	namespace, err := c.CurrentNamespace(ctx)
	if err != nil {
		t.Fatalf("%s: current namespace: %v", driver, err)
	}
	author := orm.CatalogTableRef{Namespace: namespace, Name: "author"}
	meta, err := c.DescribeTable(ctx, author)
	if err != nil {
		t.Fatalf("%s: author metadata: %v", driver, err)
	}
	if !slices.Equal(meta.PrimaryKey, []string{"seq"}) || !meta.ReliableRowIdentity {
		t.Fatalf("%s: author key %v reliable %v", driver, meta.PrimaryKey, meta.ReliableRowIdentity)
	}
	names := make([]string, 0, len(meta.Columns))
	for _, column := range meta.Columns {
		names = append(names, column.Name)
	}
	if !slices.Contains(names, "start_dt") {
		t.Fatalf("%s: author columns %v lack start_dt", driver, names)
	}

	page, err := c.TablePage(ctx, author, 3, 0)
	if err != nil {
		t.Fatalf("%s: author page: %v", driver, err)
	}
	if !slices.Equal(page.OrderBy, []string{"seq"}) || !page.HasMore {
		t.Fatalf("%s: author page order %v has_more %v", driver, page.OrderBy, page.HasMore)
	}
	if len(page.Result.Rows) != 3 {
		t.Fatalf("%s: author page rows %d, want 3", driver, len(page.Result.Rows))
	}

	count, err := c.ReadOnlyQuery(ctx, "SELECT COUNT(*) FROM "+catalogQuote("user", driver), nil, orm.CatalogQueryLimits{})
	if err != nil {
		t.Fatalf("%s: user count: %v", driver, err)
	}
	if got := count.Rows[0][0]; got != int64(5000) {
		t.Fatalf("%s: user count %v, want 5000", driver, got)
	}
	_, err = c.ReadOnlyQuery(ctx, "UPDATE "+catalogQuote("user", driver)+" SET name = name WHERE seq = 1", nil, orm.CatalogQueryLimits{})
	if err == nil || !strings.Contains(err.Error(), "QUERY_READ_ONLY") {
		t.Fatalf("%s: a write through ReadOnlyQuery returned %v, want QUERY_READ_ONLY", driver, err)
	}
}

// Requirements: SCH-5, SCH-6a.
func TestCoverageCatalogRowMutation(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer c.Close()

	account := catalogQuote("composite_account", driver)
	countSQL := "SELECT COUNT(*) FROM " + account + " WHERE tenant_id = 990005"
	tenantRows := func() any {
		result, err := c.ReadOnlyQuery(ctx, countSQL, nil, orm.CatalogQueryLimits{})
		if err != nil {
			t.Fatalf("%s: tenant count: %v", driver, err)
		}
		return result.Rows[0][0]
	}
	if got := tenantRows(); got != int64(0) {
		t.Fatalf("%s: a composite_account row of tenant %d already exists: %v", driver, catalogTenant, got)
	}

	namespace, err := c.CurrentNamespace(ctx)
	if err != nil {
		t.Fatalf("%s: current namespace: %v", driver, err)
	}
	table := orm.CatalogTableRef{Namespace: namespace, Name: "composite_account"}
	meta, err := c.DescribeTable(ctx, table)
	if err != nil {
		t.Fatalf("%s: composite_account metadata: %v", driver, err)
	}

	inserted, err := c.InsertRow(ctx, meta, []orm.CatalogAssignment{
		{Name: "tenant_id", Value: int64(catalogTenant)},
		{Name: "account_id", Value: int64(1)},
		{Name: "name", Value: "catalog"},
	})
	if err != nil || len(inserted.Rows) != 1 {
		t.Fatalf("%s: insert: rows %v, err %v", driver, inserted, err)
	}

	snapshot := catalogFindTenantRow(t, ctx, c, table, driver, "catalog")
	updated, err := c.UpdateRow(ctx, snapshot, []orm.CatalogAssignment{{Name: "name", Value: "catalog-updated"}})
	if err != nil || len(updated.Rows) != 1 {
		t.Fatalf("%s: update: rows %v, err %v", driver, updated, err)
	}

	snapshot = catalogFindTenantRow(t, ctx, c, table, driver, "catalog-updated")
	deleted, err := c.DeleteRow(ctx, snapshot)
	if err != nil || deleted != 1 {
		t.Fatalf("%s: delete: %d rows, err %v", driver, deleted, err)
	}
	if got := tenantRows(); got != int64(0) {
		t.Fatalf("%s: rows left after delete: %v", driver, got)
	}
}

// catalogFindTenantRow reads the page of composite_account, finds the one row of the test tenant and returns its snapshot
// with its name, which must be wantName.
func catalogFindTenantRow(t *testing.T, ctx context.Context, c *orm.CatalogConnection, table orm.CatalogTableRef, driver, wantName string) orm.CatalogRowSnapshot {
	t.Helper()
	page, err := c.TablePage(ctx, table, 1000, 0)
	if err != nil {
		t.Fatalf("%s: composite_account page: %v", driver, err)
	}
	if page.HasMore {
		t.Fatalf("%s: composite_account has more rows than one page", driver)
	}
	found := -1
	for i, row := range page.Result.Rows {
		if page.Column(row, "tenant_id") == int64(catalogTenant) {
			if found >= 0 {
				t.Fatalf("%s: more than one row of tenant %d", driver, catalogTenant)
			}
			found = i
		}
	}
	if found < 0 {
		t.Fatalf("%s: no row of tenant %d", driver, catalogTenant)
	}
	if got := page.Column(page.Result.Rows[found], "name"); got != wantName {
		t.Fatalf("%s: name %v, want %s", driver, got, wantName)
	}
	snapshot, err := orm.CatalogSnapshotFromPage(page, found)
	if err != nil {
		t.Fatalf("%s: row snapshot: %v", driver, err)
	}
	return snapshot
}
