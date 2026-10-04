package decimalmodel_test

import (
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/polyspec/orm/clients/go/decimalmodel"
	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
	_ "github.com/polyspec/orm/clients/go/orm/pg"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"

	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/internal/testdb"
)

// schemaSetDatabase는 case가 혼자 쓰는 database(internal/testdb)의 DSN이다.
// ORM_TEST_MYSQL_DSN이나 ORM_TEST_POSTGRES_DSN의 server에 새 database를 만들고, SQLite는
// 새 file이며, test가 끝나면 지운다.
func schemaSetDatabase(t *testing.T, driver string) string {
	t.Helper()
	return testdb.New(t, driver)
}

// schemaSet은 bench set의 connect helper로 연결하고 bench와 decimal schema를
// 설치한 뒤(decimal은 두 번, 두 번째 설치는 아무것도 바꾸지 않는다), 두 set의
// generated model을 그 연결에서 transaction 안팎으로 쓴다.
func schemaSet(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	db, err := model.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, schema := range []*orm.Schema{model.Schema, decimalmodel.Schema, decimalmodel.Schema} {
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

// counted는 db가 실행한 statement 수를 n에 센다.
func counted(db *orm.DB, n *int) { db.Subscribe(func(orm.StatementEvent) error { *n++; return nil }) }

// schemaSetUnregistered는 연결에 등록되지 않은 set의 요청이 table이 있어도
// 실행 전에 SCHEMA_HASH_MISMATCH로 실패하는지 확인한다. raw 연결은 아무 set도
// 등록하지 않고, bench helper로 연 연결은 다른 연결이 설치한 decimal set을
// 등록하지 않는다. decimal helper로 연 연결은 그 set을 쓴다.
func schemaSetUnregistered(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	var rawRuns, coreRuns int
	raw, err := orm.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	counted(raw, &rawRuns)
	defer raw.Close()
	if _, err := model.User().Connect(raw).GetCount(); orm.ErrorCode(err) != orm.CodeSchemaHashMismatch {
		t.Fatalf("bench read on a raw connection = %v, want SCHEMA_HASH_MISMATCH", err)
	}
	core, err := model.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	counted(core, &coreRuns)
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

// schemaSetEditedManifest는 text가 선언한 manifestHash로 hash되지 않는 schema를
// 확인한다. 그 schema의 설치와 connect는 어떤 statement보다 먼저 CONFIG이고
// table을 만들지 않는다. 그 text를 품은 model의 요청은 같은 hash의 같은 요청이
// plan된 뒤에도 실행 전에 SCHEMA_HASH_MISMATCH다.
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
	counted(db, &runs)
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
	// 같은 hash의 같은 요청을 먼저 plan해 둔다.
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
