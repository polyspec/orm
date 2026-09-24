package orm_test

import (
	"bytes"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	orderedjson "github.com/polyspec/ordered-json/go"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

// An encrypted JSON value is a blob column with the stages json and aes.
const aesJSONSchema = `erDiagram
  secret_config {
    bigint   seq             PK "auto"
    int      aes_key_version
    longblob config             "json aes"
  }
`

const aesJSONText = `{"z":{},"a":[],"token":"s3cret-token","nested":{"second":2,"first":1.50}}`

// TestAESJSONColumnSchema rejects an encrypted JSON value without a key
// version column and an AES stage on a jsontext column.
func TestAESJSONColumnSchema(t *testing.T) {
	for _, c := range []struct{ source, err string }{
		{"erDiagram\n  secret_config {\n    bigint seq PK \"auto\"\n    longblob config \"json aes\"\n  }\n", "secret_config.config requires a non-null integer aes version column"},
		{"erDiagram\n  secret_config {\n    bigint seq PK \"auto\"\n    int aes_key_version\n    jsontext config \"json aes\"\n  }\n", "column config: a jsontext column takes only the json or jsons stage"},
	} {
		d, err := schema.Parse(c.source)
		if err == nil {
			_, err = schema.Build(d)
		}
		if err == nil || !strings.Contains(err.Error(), c.err) {
			t.Fatalf("build error = %v, want %q", err, c.err)
		}
	}
}

// TestAESJSONColumn writes an ordered-json value to an encrypted column, reads
// it back unchanged, and rotates it to another key version on the three
// databases.
func TestAESJSONColumn(t *testing.T) {
	d, err := schema.Parse(aesJSONSchema)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	sqlitePath := filepath.Join(t.TempDir(), "aes-json.sqlite")
	targets := map[string]string{
		"sqlite":   "sqlite://" + sqlitePath,
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	for driver, dsn := range targets {
		t.Run(driver, func(t *testing.T) {
			requireTarget(t, driver, dsn)
			dropTable(t, driver, dsn, "secret_config")
			defer dropTable(t, driver, dsn, "secret_config")
			eng, err := engine.New(m, driver)
			if err != nil {
				t.Fatal(err)
			}
			open := func(keys map[int32]string, current int32) *orm.DB {
				db, err := orm.Open(dsn, eng, orm.Config{AESKeys: keys, AESVersion: current, AESKey: keys[current]})
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
			entity := rowEntity("secret_config", m.SchemaHash, "seq", "aes_key_version", "config")
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
				q.Where("", []orm.ChainKey{{Column: "seq"}}, orm.AsInt64(seq))
				rows, err := orm.Gets[*keywordRow](q)
				if err != nil {
					t.Fatalf("read: %v", err)
				}
				if rows.Len() != 1 {
					t.Fatalf("rows: %d", rows.Len())
				}
				value, ok := rows.First().vals["config"].(*orderedjson.Value)
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
				if err := raw.QueryRow(query, orm.AsInt64(seq)).Scan(&cell, &version); err != nil {
					t.Fatal(err)
				}
				return cell, version
			}

			value, err := orderedjson.Parse(aesJSONText)
			if err != nil {
				t.Fatal(err)
			}
			c := model(first)
			c.Set("config", value)
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
			u.Set("config", updated)
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

const aesJSONAuditSchema = "er" + "Diagram\n" +
	"  audit_secret {\n" +
	"    bigint       seq             PK \"auto\"\n" +
	"    varchar(36)  service_ref\n" +
	"    int          aes_key_version\n" +
	"    longblob     config             \"json aes\"\n" +
	"  }\n" +
	"  %% orm:table entity=audit_secret name=app.audit_secret\n" +
	"  %% orm:audit_log operation=app.audit_operation(seq, operation_uuid) context=app.operation_id change=app.audit_change(operation_seq, change_kind, service_ref, table_label, entity_ref, before_value, after_value)\n" +
	"  %% orm:audit entity=audit_secret mode=changes\n"

// TestAESJSONColumnAudit records an encrypted column in audit changes as the
// redaction marker, never as its plaintext or its ciphertext.
func TestAESJSONColumnAudit(t *testing.T) {
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "aes-audit.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	marker := map[string]any{"redacted": true, "present": true}
	for driver, dsn := range targets {
		t.Run(driver, func(t *testing.T) {
			requireTarget(t, driver, dsn)
			tables := []string{"app.audit_secret", "app.audit_change", "app.audit_operation"}
			if driver == "mysql" {
				tables = []string{"audit_secret", "audit_change", "audit_operation"}
			}
			logs, logManifest := auditManifest(t, auditLogSchema, driver)
			m, manifest := auditManifest(t, aesJSONAuditSchema, driver)
			dropAuditSchema(t, driver, dsn, tables)
			defer dropAuditSchema(t, driver, dsn, tables)
			eng, err := engine.New(m, driver)
			if err != nil {
				t.Fatal(err)
			}
			db, err := orm.Open(dsn, eng, orm.Config{AESKey: "audit-key", AESVersion: 1, AESKeys: map[int32]string{1: "audit-key"}})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			for _, text := range [][]byte{logManifest, manifest} {
				if err := db.Utils().Schema().Install(text); err != nil {
					t.Fatal(err)
				}
			}
			operations := rowEntity("audit_operation", logs.SchemaHash, "seq", "operation_uuid")
			changes := rowEntity("audit_change", logs.SchemaHash, "seq", "operation_seq", "change_kind", "service_ref", "table_label", "entity_ref", "before_value", "after_value")
			secrets := rowEntity("audit_secret", m.SchemaHash, "seq", "service_ref", "aes_key_version", "config")
			first, err := orderedjson.Parse(`{"token":"first-plain-token"}`)
			if err != nil {
				t.Fatal(err)
			}
			second, err := orderedjson.Parse(`{"token":"second-plain-token"}`)
			if err != nil {
				t.Fatal(err)
			}
			sqlitePath := strings.TrimPrefix(dsn, "sqlite://")
			write := func(fn func() error) {
				t.Helper()
				if err := db.Transaction(func() error {
					if err := db.Utils().SetLocal("app.operation_id", "op-1"); err != nil {
						return err
					}
					return fn()
				}, orm.Retry(0)); err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Transaction(func() error {
				op := orm.NewCore(operations)
				operations.New(op)
				op.Set("operation_uuid", "op-1")
				_, err := op.Create()
				return err
			}, orm.Retry(0)); err != nil {
				t.Fatal(err)
			}
			var seq any
			var ciphertexts [][]byte
			write(func() error {
				c := orm.NewCore(secrets)
				secrets.New(c)
				c.Set("service_ref", "s1")
				c.Set("config", first)
				created, err := c.Create()
				if err == nil {
					seq = created.(*keywordRow).vals["seq"]
				}
				return err
			})
			ciphertexts = append(ciphertexts, storedCell(t, driver, dsn, sqlitePath, tables[0], seq))
			write(func() error {
				u := orm.NewCore(secrets)
				secrets.New(u)
				u.Set("seq", seq)
				u.Set("config", second)
				return u.Update(nil)
			})
			ciphertexts = append(ciphertexts, storedCell(t, driver, dsn, sqlitePath, tables[0], seq))
			write(func() error {
				d := orm.NewCore(secrets)
				secrets.New(d)
				d.Set("seq", seq)
				return d.Delete(nil)
			})
			q := orm.NewCore(changes)
			changes.New(q)
			q.Connect(db)
			q.AddAllColumns()
			q.OrderBy("seq", false, nil)
			rows, err := orm.Gets[*keywordRow](q)
			if err != nil {
				t.Fatal(err)
			}
			var kinds []string
			var all []*keywordRow
			for _, row := range rows.All() {
				all = append(all, row)
				kinds = append(kinds, row.vals["change_kind"].(string))
				text := strings.ToLower(string(mustJSON(t, row.vals)))
				if strings.Contains(text, "plain-token") {
					t.Fatalf("the plaintext is recorded: %s", text)
				}
				for _, cell := range ciphertexts {
					if strings.Contains(text, hex.EncodeToString(cell)) || strings.Contains(text, hex.EncodeToString(cell[len(cell)-16:])) {
						t.Fatalf("the ciphertext is recorded: %s", text)
					}
				}
				for _, column := range []string{"before_value", "after_value"} {
					values := jsonText(t, row.vals[column]).(map[string]any)
					if config, ok := values["config"]; ok && !reflect.DeepEqual(config, marker) {
						t.Fatalf("%s config: %v", column, config)
					}
				}
			}
			if strings.Join(kinds, ",") != "INSERT,UPDATE,DELETE" {
				t.Fatalf("change kinds: %v", kinds)
			}
			insert := jsonText(t, all[0].vals["after_value"]).(map[string]any)
			update := jsonText(t, all[1].vals["after_value"]).(map[string]any)
			remove := jsonText(t, all[2].vals["before_value"]).(map[string]any)
			for _, values := range []map[string]any{insert, update, remove} {
				if !reflect.DeepEqual(values["config"], marker) {
					t.Fatalf("config value: %v", values)
				}
			}
		})
	}
}

// storedCell reads the stored bytes of the config column.
func storedCell(t *testing.T, driver, dsn, sqlitePath, table string, seq any) []byte {
	t.Helper()
	var raw *sql.DB
	query := "SELECT config FROM " + table + " WHERE seq = $1"
	switch driver {
	case "sqlite":
		var err error
		if raw, err = sql.Open("sqlite", sqlitePath); err != nil {
			t.Fatal(err)
		}
		query = `SELECT config FROM "app__audit_secret" WHERE seq = $1`
	case "mysql":
		raw = openNative(t, driver, dsn)
		query = "SELECT config FROM " + table + " WHERE seq = ?"
	default:
		raw = openNative(t, driver, dsn)
	}
	defer raw.Close()
	var cell []byte
	if err := raw.QueryRow(query, orm.AsInt64(seq)).Scan(&cell); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(cell, []byte("ORM-AES2\x00")) {
		t.Fatalf("stored cell %q", cell)
	}
	return cell
}
