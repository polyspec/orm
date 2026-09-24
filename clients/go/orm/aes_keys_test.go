package orm_test

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

const aesKeysSchema = `erDiagram
  secret_note {
    bigint   seq             PK "auto"
    int      aes_key_version
    longblob note             "aes"
  }
`

// TestAESWriteUsesKeyOfCurrentVersion writes an AES column with only AESKeys
// and AESVersion configured. The write uses AESKeys[AESVersion], and a
// connection with only that version's key reads the value.
func TestAESWriteUsesKeyOfCurrentVersion(t *testing.T) {
	d, err := schema.Parse(aesKeysSchema)
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
	eng, err := engine.New(m, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	dsn := "sqlite://" + filepath.Join(t.TempDir(), "aes-keys.sqlite")
	open := func(cfg orm.Config) *orm.DB {
		t.Helper()
		db, err := orm.Open(dsn, eng, cfg)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Close() })
		return db
	}
	writer := open(orm.Config{AESKeys: map[int32]string{1: "note-key-one", 2: "note-key-two"}, AESVersion: 2})
	if err := writer.Utils().Schema().Install(manifest); err != nil {
		t.Fatal(err)
	}
	entity := rowEntity("secret_note", m.SchemaHash, "seq", "aes_key_version", "note")
	model := func(db *orm.DB) *orm.Core {
		c := orm.NewCore(entity)
		entity.New(c)
		c.Connect(db)
		return c
	}
	c := model(writer)
	c.Set("note", "private note")
	created, err := c.Create()
	if err != nil {
		t.Fatalf("create with AESKeys and AESVersion: %v", err)
	}
	seq := created.(*keywordRow).vals["seq"]
	q := model(open(orm.Config{AESKeys: map[int32]string{2: "note-key-two"}, AESVersion: 2}))
	q.AddAllColumns()
	q.Where("", []orm.ChainKey{{Column: "seq"}}, orm.AsInt64(seq))
	rows, err := orm.Gets[*keywordRow](q)
	if err != nil {
		t.Fatalf("read with the version 2 key: %v", err)
	}
	if rows.Len() != 1 || rows.First().vals["note"] != "private note" || orm.AsInt64(rows.First().vals["aes_key_version"]) != 2 {
		t.Fatalf("row %#v", rows.First().vals)
	}
}

// TestAESKeyMustMatchKeyOfCurrentVersion rejects a configuration whose AESKey
// differs from AESKeys[AESVersion].
func TestAESKeyMustMatchKeyOfCurrentVersion(t *testing.T) {
	d, err := schema.Parse(aesKeysSchema)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	eng, err := engine.New(m, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	_, err = orm.Open("sqlite://"+filepath.Join(t.TempDir(), "aes-conflict.sqlite"), eng,
		orm.Config{AESKey: "other-key", AESKeys: map[int32]string{1: "note-key-one"}, AESVersion: 1})
	if orm.ErrorCode(err) != orm.CodeConfig || !strings.Contains(err.Error(), "AESKey") {
		t.Fatalf("open error = %v, want CONFIG about AESKey", err)
	}
}
