package decimalmodel_test

import (
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/polyspec/orm/packages/go/decimalmodel"
	"github.com/polyspec/orm/packages/go/internal/benchset"
	"github.com/polyspec/orm/packages/go/model"
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

// schemaSet connects with the bench set's connect helper and installs the bench set (benchset.Install) and the decimal schema
// (decimal twice; the second install changes nothing), and uses the generated models of both sets
// inside and outside transactions on that connection.
func schemaSet(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	db, err := model.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := benchset.Install(db); err != nil {
		t.Fatal(err)
	}
	for _, schema := range []*orm.Schema{decimalmodel.Schema, decimalmodel.Schema} {
		if err := db.Utils().Schema().Install(schema); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := model.User().Connect(db).SetName("core").Create(); err != nil {
		t.Fatal(err)
	}
	row, err := decimalmodel.DecimalCase().Connect(db).SetSeq(1).SetAmount("48.0450")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := row.Create(); err != nil {
		t.Fatal(err)
	}
	if err := db.Transaction(func() error {
		if _, err := model.User().SetName("core-tx").Create(); err != nil {
			return err
		}
		row, err := decimalmodel.DecimalCase().SetSeq(2).SetAmount("1.5000")
		if err != nil {
			return err
		}
		_, err = row.Create()
		return err
	}); err != nil {
		t.Fatal(err)
	}
	users, err := model.User().Connect(db).GetCount()
	if err != nil || users != 2 {
		t.Fatalf("core rows = %d, %v; want 2", users, err)
	}
	loaded, err := decimalmodel.DecimalCase().Connect(db).Seq(1).Get()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.GetAmount() != "48.0450" {
		t.Fatalf("decimal amount = %q", loaded.GetAmount())
	}
	decimals, err := decimalmodel.DecimalCase().Connect(db).GetCount()
	if err != nil || decimals != 2 {
		t.Fatalf("decimal rows = %d, %v; want 2", decimals, err)
	}
}

// Requirements: SCH-7, DBS-108.
func TestSchemaSetSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSet(t, "sqlite")
}
func TestSchemaSetMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSet(t, "mysql")
}
func TestSchemaSetPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSet(t, "postgres")
}

// counted counts into n the statements that the db executed.
func counted(t *testing.T, db *orm.DB, n *int) {
	t.Helper()
	if _, err := db.Subscribe(func(orm.StatementEvent) error { *n++; return nil }); err != nil {
		t.Fatal(err)
	}
}

// schemaSetUnregistered checks that a request of a set not registered on the connection fails with
// SCHEMA_HASH_MISMATCH before execution, even when the table exists. A raw connection registers no set, and a
// connection opened with the bench helper registers no decimal set that another connection installed,
// and a connection opened with the decimal helper uses that set.
func schemaSetUnregistered(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	var rawRuns, coreRuns int
	raw, err := orm.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	counted(t, raw, &rawRuns)
	defer raw.Close()
	if _, err := model.User().Connect(raw).GetCount(); orm.ErrorCode(err) != orm.CodeSchemaHashMismatch {
		t.Fatalf("bench read on a raw connection = %v, want SCHEMA_HASH_MISMATCH", err)
	}
	core, err := model.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	counted(t, core, &coreRuns)
	defer core.Close()
	installer, err := decimalmodel.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := installer.Utils().Schema().Install(decimalmodel.Schema); err != nil {
		t.Fatal(err)
	}
	row, err := decimalmodel.DecimalCase().Connect(installer).SetSeq(1).SetAmount("1.0000")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := row.Create(); err != nil {
		t.Fatal(err)
	}
	installer.Close()
	if _, err := decimalmodel.DecimalCase().Connect(core).GetCount(); orm.ErrorCode(err) != orm.CodeSchemaHashMismatch {
		t.Fatalf("decimal read on the bench connection = %v, want SCHEMA_HASH_MISMATCH", err)
	}
	write, err := decimalmodel.DecimalCase().Connect(core).SetSeq(2).SetAmount("2.0000")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := write.Create(); orm.ErrorCode(err) != orm.CodeSchemaHashMismatch {
		t.Fatalf("decimal write on the bench connection = %v, want SCHEMA_HASH_MISMATCH", err)
	}
	if rawRuns != 0 || coreRuns != 0 {
		t.Fatalf("unregistered requests ran statements: raw %d, bench %d", rawRuns, coreRuns)
	}
	decimal, err := decimalmodel.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer decimal.Close()
	if n, err := decimalmodel.DecimalCase().Connect(decimal).GetCount(); err != nil || n != 1 {
		t.Fatalf("decimal rows through the decimal helper = %d, %v; want 1", n, err)
	}
}

func TestSchemaSetUnregisteredSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSetUnregistered(t, "sqlite")
}
func TestSchemaSetUnregisteredMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSetUnregistered(t, "mysql")
}
func TestSchemaSetUnregisteredPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSetUnregistered(t, "postgres")
}

// schemaSetEditedManifest checks a schema whose text does not hash to the manifestHash that the text declares.
// Installing and connecting that schema fails with CONFIG before any statement, and it creates no table. A request
// of a model that embeds that text, with the same hash as a request
// already planned, still fails with SCHEMA_HASH_MISMATCH before execution.
func schemaSetEditedManifest(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	edited := &orm.Schema{Hash: decimalmodel.ManifestHash, Text: strings.ReplaceAll(decimalmodel.ManifestText, "decimal(13,4)", "decimal(14,4)")}
	if edited.Text == decimalmodel.ManifestText {
		t.Fatal("edited manifest does not differ")
	}
	if _, err := orm.ConnectSchema(dsn, edited, orm.Config{}); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("connect with an edited manifest = %v, want CONFIG", err)
	}
	var runs int
	db, err := decimalmodel.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	counted(t, db, &runs)
	defer db.Close()
	if err := db.Utils().Schema().Install(edited); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("install of an edited manifest = %v, want CONFIG", err)
	}
	if runs != 0 {
		t.Fatalf("the edited install ran %d statements", runs)
	}
	if err := db.Utils().Schema().Install(decimalmodel.Schema); err != nil {
		t.Fatal(err)
	}
	// First plans the same request with the same hash.
	if n, err := decimalmodel.DecimalCase().Connect(db).GetCount(); err != nil || n != 0 {
		t.Fatalf("decimal rows before the edited request = %d, %v", n, err)
	}
	before := runs
	c := orm.NewCore(&orm.Entity{Name: "decimal_case", Schema: edited})
	c.Connect(db)
	if _, err := c.GetCount(); orm.ErrorCode(err) != orm.CodeSchemaHashMismatch {
		t.Fatalf("request of an edited manifest = %v, want SCHEMA_HASH_MISMATCH", err)
	}
	if runs != before {
		t.Fatalf("the edited request ran %d statements", runs-before)
	}
}

func TestSchemaSetEditedManifestSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSetEditedManifest(t, "sqlite")
}
func TestSchemaSetEditedManifestMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSetEditedManifest(t, "mysql")
}
func TestSchemaSetEditedManifestPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	schemaSetEditedManifest(t, "postgres")
}
