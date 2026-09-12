package orm

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigVersionedAESKeys(t *testing.T) {
	dir := t.TempDir()
	schemaPath := filepath.Join(dir, "schema.json")
	if err := os.WriteFile(schemaPath, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "orm.toml")
	body := fmt.Sprintf("schema = %q\n[db]\ndsn = \"root@tcp(localhost:3306)/test\"\n[secrets]\naes_version = 2\n[secrets.aes_keys]\n1 = \"old-key\"\n2 = \"current-key\"\n", schemaPath)
	if err := os.WriteFile(configPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := LoadConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	key, err := config.AESKey()
	if err != nil || key != "current-key" {
		t.Fatalf("current key=%q err=%v", key, err)
	}
	keyring, err := config.AESKeyring()
	if err != nil || keyring.CurrentAESVersion() != 2 {
		t.Fatalf("keyring=%#v err=%v", keyring, err)
	}
}
