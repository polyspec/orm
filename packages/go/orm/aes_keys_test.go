package orm_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

const aesKeysSchema = `dbspec 1 aes_keys

table secret_note {
  seq i64 identity
  aes_key_version i32
  note bytes
  primary key (seq)
  settings {
    codec note aes
    aes_version aes_key_version
  }
}
`

// TestAESWriteUsesKeyOfCurrentVersion writes an AES column with only AESKeys
// and AESVersion configured. The write uses AESKeys[AESVersion], and a
// connection with only that version's key reads the value.
// TestAESKeyMustMatchKeyOfCurrentVersion rejects a configuration whose AESKey
// differs from AESKeys[AESVersion].
// Requirements: COD-8.
func TestAESKeyMustMatchKeyOfCurrentVersion(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := documentSchema(t, aesKeysSchema)
	_, err := orm.ConnectSchema("sqlite://"+filepath.Join(t.TempDir(), "aes-conflict.sqlite"), s,
		orm.Config{AESKey: "other-key", AESKeys: map[int32]string{1: "note-key-one"}, AESVersion: 1})
	if orm.ErrorCode(err) != orm.CodeConfig || !strings.Contains(err.Error(), "AESKey") {
		t.Fatalf("open error = %v, want CONFIG about AESKey", err)
	}
}
