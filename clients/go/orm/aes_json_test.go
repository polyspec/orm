package orm_test

import (
	"bytes"
	"database/sql"
	"strings"
	"testing"

	orderedjson "github.com/polyspec/ordered-json/go"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
)

const aesJSONText = `{"z":{},"a":[],"token":"s3cret-token","nested":{"second":2,"first":1.50}}`

// TestAESJSONColumnSchema는 key version setting 없는 AES codec과 text
// column에 저장하는 AES codec을 SCHEMA_INVALID setting diagnostic으로 거부한다.
func TestAESJSONColumnSchema(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, c := range []struct{ document, message string }{
		{"dbspec 1 secret\n\ntable secret_config {\n  seq i64 identity\n  config bytes\n  primary key (seq)\n  settings {\n    codec config ordered_json aes\n  }\n}\n", "aes_version"},
		{"dbspec 1 secret\n\ntable secret_config {\n  seq i64 identity\n  aes_key_version i32\n  config text\n  primary key (seq)\n  settings {\n    codec config ordered_json aes\n    aes_version aes_key_version\n  }\n}\n", "bytes"},
	} {
		_, diagnostics := runtimemodel.LoadDocuments([]string{c.document})
		if len(diagnostics) == 0 || diagnostics[0].Rule != dbspec.RuleSetting || !strings.Contains(diagnostics[0].Message, c.message) {
			t.Fatalf("diagnostics = %v, want a setting diagnostic about %s", diagnostics, c.message)
		}
	}
}

// TestAESJSONColumn writes an ordered-json value to an encrypted column, reads
// it back unchanged, and rotates it to another key version on the three
// databases.
func TestAESJSONColumn(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "secret_config")
	manifest := s
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			dsn := newDatabase(t, driver)
			sqlitePath := strings.TrimPrefix(dsn, "sqlite://")
			open := func(keys map[int32]string, current int32) *orm.DB {
				db, err := orm.ConnectSchema(dsn, s, orm.Config{AESKeys: keys, AESVersion: current, AESKey: keys[current]})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { db.Close() })
				return db
			}
			first := open(map[int32]string{1: "config-key-one"}, 1)
			if err := first.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			entity := rowEntity("secret_config", s, "seq", "aes_key_version", "config")
			model := func(db *orm.DB) *orm.Core {
				c := orm.NewCore(entity)
				entity.New(c)
				c.Connect(db)
				return c
			}
			read := func(db *orm.DB, seq any) string {
				t.Helper()
				q := model(db)
				q.AddAllColumns()
				q.Where("", []orm.ChainKey{{Column: "seq"}}, mustInt64(seq))
				rows, err := orm.Gets[*keywordRow](q)
				if err != nil {
					t.Fatalf("read: %v", err)
				}
				if rows.Len() != 1 {
					t.Fatalf("rows: %d", rows.Len())
				}
				styled, ok := rows.First().vals["config"].(orm.StyledValue)
				if !ok || styled.Kind() != "value" {
					t.Fatalf("config state is %T (%v)", rows.First().vals["config"], rows.First().vals["config"])
				}
				data, _ := styled.Data()
				value, ok := data.(*orderedjson.Value)
				if !ok {
					t.Fatalf("config is %T", rows.First().vals["config"])
				}
				text, err := orderedjson.Stringify(value)
				if err != nil {
					t.Fatal(err)
				}
				return text
			}
			stored := func(seq any) ([]byte, int64) {
				t.Helper()
				var raw *sql.DB
				if driver == "sqlite" {
					var err error
					raw, err = sql.Open("sqlite", sqlitePath)
					if err != nil {
						t.Fatal(err)
					}
				} else {
					raw = openNative(t, driver, dsn)
				}
				defer raw.Close()
				query := `SELECT config, aes_key_version FROM secret_config WHERE seq = $1`
				if driver == "mysql" {
					query = "SELECT config, aes_key_version FROM secret_config WHERE seq = ?"
				}
				var cell []byte
				var version int64
				if err := raw.QueryRow(query, mustInt64(seq)).Scan(&cell, &version); err != nil {
					t.Fatal(err)
				}
				return cell, version
			}

			value, err := orderedjson.Parse(aesJSONText)
			if err != nil {
				t.Fatal(err)
			}
			c := model(first)
			c.Set("config", orm.Value(value))
			created, err := c.Create()
			if err != nil {
				t.Fatalf("create: %v", err)
			}
			seq := created.(*keywordRow).vals["seq"]
			if got := read(first, seq); got != aesJSONText {
				t.Fatalf("read back %s, want %s", got, aesJSONText)
			}
			cell, version := stored(seq)
			if !bytes.HasPrefix(cell, []byte("ORM-AES2\x00")) || bytes.Contains(cell, []byte("s3cret-token")) || version != 1 {
				t.Fatalf("stored cell %q version %d", cell, version)
			}

			second := open(map[int32]string{1: "config-key-one", 2: "config-key-two"}, 2)
			if got := read(second, seq); got != aesJSONText {
				t.Fatalf("mixed-version read %s", got)
			}
			keyring, err := orm.NewAESKeyring(map[int32]string{1: "config-key-one", 2: "config-key-two"}, 2)
			if err != nil {
				t.Fatal(err)
			}
			target := entity.New(orm.NewCore(entity))
			target.Orm_().Connect(second)
			rotated, err := second.Utils().Aes().Rotate(target, keyring)
			if err != nil || rotated != 1 {
				t.Fatalf("rotate: %d %v", rotated, err)
			}
			if _, version := stored(seq); version != 2 {
				t.Fatalf("rotated version %d", version)
			}
			if got := read(open(map[int32]string{2: "config-key-two"}, 2), seq); got != aesJSONText {
				t.Fatalf("rotated read %s", got)
			}

			updated, err := orderedjson.Parse(`{"token":"next-token","list":[1,"two",null]}`)
			if err != nil {
				t.Fatal(err)
			}
			u := model(first)
			u.Set("seq", seq)
			u.Set("config", orm.Value(updated))
			if err := u.Update(nil); err != nil {
				t.Fatalf("update: %v", err)
			}
			if _, version := stored(seq); version != 1 {
				t.Fatalf("updated version %d", version)
			}
			if got := read(first, seq); got != `{"token":"next-token","list":[1,"two",null]}` {
				t.Fatalf("updated read %s", got)
			}
		})
	}
}
