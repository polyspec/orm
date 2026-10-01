package decimalmodel_test

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/polyspec/orm/clients/go/decimalmodel"
	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

// schemaSetDatabase returns the DSN of a new database on the server that
// ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN names and drops it when the test
// ends. For SQLite it returns a new file.
func schemaSetDatabase(t *testing.T, driver string) string {
	t.Helper()
	if driver == "sqlite" {
		return "sqlite://" + filepath.Join(t.TempDir(), "schema-set.sqlite")
	}
	env := "ORM_TEST_" + strings.ToUpper(driver) + "_DSN"
	base := os.Getenv(env)
	if base == "" {
		t.Fatalf("%s is required; database tests never skip", env)
	}
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	sqlDriver, native := "pgx", base
	if driver == "mysql" {
		cfg := mysql.NewConfig()
		cfg.User = u.User.Username()
		cfg.Passwd, _ = u.User.Password()
		cfg.DBName = strings.TrimPrefix(u.Path, "/")
		cfg.Net, cfg.Addr = "tcp", u.Host
		sqlDriver, native = "mysql", cfg.FormatDSN()
	}
	server, err := sql.Open(sqlDriver, native)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("orm_schema_set_%d", time.Now().UnixNano())
	if _, err := server.Exec("CREATE DATABASE " + name); err != nil {
		server.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		defer server.Close()
		stmt := "DROP DATABASE " + name
		if driver == "postgres" {
			stmt += " WITH (FORCE)"
		}
		if _, err := server.Exec(stmt); err != nil {
			t.Errorf("drop database %s: %v", name, err)
		}
	})
	u.Path = "/" + name
	return u.String()
}

// schemaSet opens a connection with the core schema, installs the core and
// decimal manifests, and uses the generated models of both schemas on that
// connection inside and outside a transaction.
func schemaSet(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	coreJSON, err := os.ReadFile("../../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	decimalJSON, err := os.ReadFile("../../../contracts/fixtures/decimal_schema.json")
	if err != nil {
		t.Fatal(err)
	}
	db, err := model.Connect(dsn, "../../../schema/schema.json", orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, manifest := range [][]byte{coreJSON, decimalJSON, decimalJSON} {
		if err := db.Utils().Schema().Install(manifest); err != nil {
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

func TestSchemaSetSQLite(t *testing.T)   { schemaSet(t, "sqlite") }
func TestSchemaSetMySQL(t *testing.T)    { schemaSet(t, "mysql") }
func TestSchemaSetPostgres(t *testing.T) { schemaSet(t, "postgres") }

// registerSchema registers the decimal manifest on a connection opened with
// the core schema. Register creates nothing: before installation the decimal
// table stays absent. After another connection installs the manifest, the
// decimal models read and write on the registering connection.
func registerSchema(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	coreJSON, err := os.ReadFile("../../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	decimalJSON, err := os.ReadFile("../../../contracts/fixtures/decimal_schema.json")
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := model.Connect(dsn, "../../../schema/schema.json", orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := fresh.Utils().Schema().Register(decimalJSON); err != nil {
		t.Fatal(err)
	}
	if _, err := decimalmodel.DecimalCase().Connect(fresh).GetCount(); orm.ErrorCode(err) != orm.CodeDriver {
		t.Fatalf("decimal read after register on an empty database = %v, want DRIVER: register creates no table", err)
	}
	fresh.Close()
	installer, err := model.Connect(dsn, "../../../schema/schema.json", orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, manifest := range [][]byte{coreJSON, decimalJSON} {
		if err := installer.Utils().Schema().Install(manifest); err != nil {
			t.Fatal(err)
		}
	}
	installer.Close()
	db, err := model.Connect(dsn, "../../../schema/schema.json", orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for range 2 {
		if err := db.Utils().Schema().Register(decimalJSON); err != nil {
			t.Fatal(err)
		}
	}
	row, err := decimalmodel.DecimalCase().Connect(db).SetSeq(3).SetAmount("2.5000")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := row.Create(); err != nil {
		t.Fatal(err)
	}
	loaded, err := decimalmodel.DecimalCase().Connect(db).Seq(3).Get()
	if err != nil || loaded.GetAmount() != "2.5000" {
		t.Fatalf("decimal row after register = %v, %v", loaded, err)
	}
}

// registerEditedManifest registers a manifest whose content differs from its
// hash, which fails with CONFIG.
func registerEditedManifest(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	decimalJSON, err := os.ReadFile("../../../contracts/fixtures/decimal_schema.json")
	if err != nil {
		t.Fatal(err)
	}
	edited := []byte(strings.ReplaceAll(string(decimalJSON), `"decimal_case"`, `"decimal_edit"`))
	if string(edited) == string(decimalJSON) {
		t.Fatal("edited manifest does not differ")
	}
	db, err := model.Connect(dsn, "../../../schema/schema.json", orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Utils().Schema().Register(edited); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("register of an edited manifest = %v, want CONFIG", err)
	}
}

func TestRegisterSchemaSQLite(t *testing.T)           { registerSchema(t, "sqlite") }
func TestRegisterSchemaMySQL(t *testing.T)            { registerSchema(t, "mysql") }
func TestRegisterSchemaPostgres(t *testing.T)         { registerSchema(t, "postgres") }
func TestRegisterEditedManifestSQLite(t *testing.T)   { registerEditedManifest(t, "sqlite") }
func TestRegisterEditedManifestMySQL(t *testing.T)    { registerEditedManifest(t, "mysql") }
func TestRegisterEditedManifestPostgres(t *testing.T) { registerEditedManifest(t, "postgres") }
