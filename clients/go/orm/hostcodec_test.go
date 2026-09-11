package orm

import (
	"encoding/json"
	"os"
	"testing"
)

// The host AES must produce exactly MySQL's HEX(AES_ENCRYPT(v, key)) bytes.
func TestHostAESMatchesMySQL(t *testing.T) {
	src, err := os.ReadFile("../../../tests/codec/aes-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Mode    string
		Vectors []struct{ Key, Plain, Hex string }
	}
	if err := json.Unmarshal(src, &f); err != nil {
		t.Fatal(err)
	}
	if f.Mode != "aes-128-ecb" {
		t.Fatalf("vectors were generated with %s", f.Mode)
	}
	for _, v := range f.Vectors {
		enc, err := HostEncode(v.Plain, []string{"aes", "hex"}, v.Key)
		if err != nil {
			t.Fatal(err)
		}
		if enc != v.Hex {
			t.Errorf("key %q plain %q: got %v want %s", v.Key, v.Plain, enc, v.Hex)
		}
		dec, err := hostDecode(v.Hex, []string{"aes", "hex"}, v.Key)
		if err != nil || dec != v.Plain {
			t.Errorf("decode key %q: %v %v", v.Key, dec, err)
		}
	}
	if _, err := hostDecode("00", []string{"aes", "hex"}, "k"); err == nil {
		t.Error("corrupt ciphertext must fail")
	}
	ip, _ := HostEncode("10.1.2.3", []string{"ip"}, "")
	if b, ok := ip.([]byte); !ok || len(b) != 4 {
		t.Errorf("ipv4 packs to 4 bytes: %v", ip)
	}
	back, _ := hostDecode(ip, []string{"ip"}, "")
	if back != "10.1.2.3" {
		t.Errorf("ip round trip: %v", back)
	}
}
