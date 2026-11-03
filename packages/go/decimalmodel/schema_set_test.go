package decimalmodel_test

import (
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/polyspec/orm/packages/go/decimalmodel"
	"github.com/polyspec/orm/packages/go/internal/testassert"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/pg"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"

	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/testcase"
)

// schemaSetDatabase is the DSN of the database (internal/testdb) that the case uses alone.
// It creates a new database on the server of ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN, and SQLite
// uses a new file, which the test removes when it ends.
func schemaSetDatabase(t *testing.T, driver string) string {
	t.Helper()
	return testdb.New(t, driver)
}

// TestDecimalDocument mirrors the fixture's independent decimal-schema case: install its generated set, write both
// values at the declared decimal(13,4) boundaries, and read their exact text on every database.
// Requirements: SCH-7, DBS-108.
func TestDecimalDocument(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			dsn := schemaSetDatabase(t, driver)
			db, err := decimalmodel.Connect(dsn, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, db)
			if err := db.Utils().Schema().Install(decimalmodel.Schema); err != nil {
				t.Fatal(err)
			}
			for _, row := range []struct {
				seq    int64
				amount string
			}{{1, "48.0450"}, {2, "123456789.1234"}} {
				model, err := decimalmodel.DecimalCase().Connect(db).SetSeq(row.seq).SetAmount(row.amount)
				if err != nil {
					t.Fatalf("set amount %s: %v", row.amount, err)
				}
				created, err := model.Create()
				if err != nil {
					t.Fatalf("create amount %s: %v", row.amount, err)
				}
				if got := testassert.ReadColumn(t, created.GetAmount); got != row.amount {
					t.Fatalf("created amount = %q, want %q", got, row.amount)
				}
				loaded, err := decimalmodel.DecimalCase().Connect(db).Seq(row.seq).Get()
				if err != nil {
					t.Fatalf("read amount %s: %v", row.amount, err)
				}
				if got := testassert.ReadColumn(t, loaded.GetAmount); got != row.amount {
					t.Fatalf("stored amount = %q, want %q", got, row.amount)
				}
			}
			if count, err := decimalmodel.DecimalCase().Connect(db).GetCount(); err != nil || count != 2 {
				t.Fatalf("decimal rows = %d, %v; want 2", count, err)
			}
		})
	}
}

// counted counts into n the statements that the db executed.
func counted(t *testing.T, db *orm.DB, n *int) {
	t.Helper()
	if _, err := db.Subscribe(func(orm.StatementEvent) error { *n++; return nil }); err != nil {
		t.Fatal(err)
	}
}

// schemaSetEditedManifest requests a model that embeds a manifest text edited under its declared hash, with the hash of a
// request already planned: the request fails with SCHEMA_HASH_MISMATCH before execution. The connect and install of that
// text are cases of the statement_events recipe.
func schemaSetEditedManifest(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	edited := &orm.Schema{Hash: decimalmodel.ManifestHash, Text: strings.ReplaceAll(decimalmodel.ManifestText, "decimal(13,4)", "decimal(14,4)")}
	if edited.Text == decimalmodel.ManifestText {
		t.Fatal("edited manifest does not differ")
	}
	db, err := decimalmodel.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	if err := db.Utils().Schema().Install(decimalmodel.Schema); err != nil {
		t.Fatal(err)
	}
	// First plans the same request with the same hash.
	if n, err := decimalmodel.DecimalCase().Connect(db).GetCount(); err != nil || n != 0 {
		t.Fatalf("decimal rows before the edited request = %d, %v", n, err)
	}
	var runs int
	counted(t, db, &runs)
	c := orm.NewCore(&orm.Entity{Name: "decimal_case", Schema: edited})
	c.Connect(db)
	if _, err := c.GetCount(); orm.ErrorCode(err) != orm.CodeSchemaHashMismatch {
		t.Fatalf("request of an edited manifest = %v, want SCHEMA_HASH_MISMATCH", err)
	}
	if runs != 0 {
		t.Fatalf("the edited request ran %d statements", runs)
	}
}

// Requirements: DBS-120, SCH-7, SCH-11.
func TestSchemaSetEditedManifestSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSetEditedManifest(t, "sqlite")
}

// Requirements: DBS-120, SCH-7, SCH-11.
func TestSchemaSetEditedManifestMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSetEditedManifest(t, "mysql")
}

// Requirements: DBS-120, SCH-7, SCH-11.
func TestSchemaSetEditedManifestPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSetEditedManifest(t, "postgres")
}
