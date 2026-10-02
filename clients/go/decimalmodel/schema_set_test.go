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
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/polyspec/orm/clients/go/decimalmodel"
	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
	_ "github.com/polyspec/orm/clients/go/orm/pg"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"
)

// schemaSetDatabase는 ORM_TEST_MYSQL_DSN이나 ORM_TEST_POSTGRES_DSN이 가리키는
// server에 새 database를 만들어 그 DSN을 돌려주고 test가 끝나면 지운다. SQLite는
// 새 file이다.
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

// schemaSet은 bench document set으로 연결하고 bench와 decimal document set을
// 설치한 뒤(decimal은 두 번, 두 번째 설치는 아무것도 바꾸지 않는다), 두 set의
// generated model을 그 연결에서 transaction 안팎으로 쓴다.
func schemaSet(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	db, err := model.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, text := range []string{model.ManifestText, decimalmodel.ManifestText, decimalmodel.ManifestText} {
		if err := db.Utils().Schema().Install(text); err != nil {
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

// schemaSetInstalledElsewhere는 다른 연결이 설치한 decimal set을 등록 호출 없이
// 쓴다. 설치 전에는 decimal table이 없으므로 그 read가 DRIVER이고 아무것도
// 만들어지지 않는다. 설치 뒤에는 먼저 열린 연결에서도 decimal model이 읽고 쓴다.
func schemaSetInstalledElsewhere(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	db, err := model.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := decimalmodel.DecimalCase().Connect(db).GetCount(); orm.ErrorCode(err) != orm.CodeDriver {
		t.Fatalf("decimal read before installation = %v, want DRIVER", err)
	}
	installer, err := decimalmodel.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{model.ManifestText, decimalmodel.ManifestText} {
		if err := installer.Utils().Schema().Install(text); err != nil {
			t.Fatal(err)
		}
	}
	installer.Close()
	row, err := decimalmodel.DecimalCase().Connect(db).SetSeq(3).SetAmount("2.5000")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := row.Create(); err != nil {
		t.Fatal(err)
	}
	loaded, err := decimalmodel.DecimalCase().Connect(db).Seq(3).Get()
	if err != nil || loaded.GetAmount() != "2.5000" {
		t.Fatalf("decimal row after installation elsewhere = %v, %v", loaded, err)
	}
}

// schemaSetEditedManifest는 manifest text가 선언한 manifestHash와 다른 model의
// 요청이 실행 전에 SCHEMA_HASH_MISMATCH로 실패하고 database를 바꾸지 않는지
// 확인한다.
func schemaSetEditedManifest(t *testing.T, driver string) {
	dsn := schemaSetDatabase(t, driver)
	db, err := decimalmodel.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Utils().Schema().Install(decimalmodel.ManifestText); err != nil {
		t.Fatal(err)
	}
	edited := strings.ReplaceAll(decimalmodel.ManifestText, "decimal(13,4)", "decimal(14,4)")
	if edited == decimalmodel.ManifestText {
		t.Fatal("edited manifest does not differ")
	}
	ent := &orm.Entity{Name: "decimal_case", Schema: &orm.Schema{Hash: decimalmodel.ManifestHash, Text: edited}}
	c := orm.NewCore(ent)
	c.Connect(db)
	if _, err := c.GetCount(); orm.ErrorCode(err) != orm.CodeSchemaHashMismatch {
		t.Fatalf("request of an edited manifest = %v, want SCHEMA_HASH_MISMATCH", err)
	}
	if n, err := decimalmodel.DecimalCase().Connect(db).GetCount(); err != nil || n != 0 {
		t.Fatalf("decimal rows after the rejected request = %d, %v", n, err)
	}
}

func TestSchemaSetInstalledElsewhereSQLite(t *testing.T) { schemaSetInstalledElsewhere(t, "sqlite") }
func TestSchemaSetInstalledElsewhereMySQL(t *testing.T)  { schemaSetInstalledElsewhere(t, "mysql") }
func TestSchemaSetInstalledElsewherePostgres(t *testing.T) {
	schemaSetInstalledElsewhere(t, "postgres")
}
func TestSchemaSetEditedManifestSQLite(t *testing.T)   { schemaSetEditedManifest(t, "sqlite") }
func TestSchemaSetEditedManifestMySQL(t *testing.T)    { schemaSetEditedManifest(t, "mysql") }
func TestSchemaSetEditedManifestPostgres(t *testing.T) { schemaSetEditedManifest(t, "postgres") }
