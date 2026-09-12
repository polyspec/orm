package orm

import (
	"bytes"
	"testing"
)

func TestHostAESUsesAuthenticatedVersionTwoEnvelope(t *testing.T) {
	stored, err := HostEncode("member@example.test", []string{"aes"}, "key-v1")
	if err != nil {
		t.Fatal(err)
	}
	b, ok := stored.([]byte)
	if !ok {
		t.Fatalf("AES without hex must bind bytes, got %T", stored)
	}
	if !bytes.HasPrefix(b, []byte("ORM-AES2\x00")) {
		t.Fatalf("AES envelope prefix = %q", b[:minInt(len(b), 9)])
	}
	if decoded, err := hostDecode(b, []string{"aes"}, "key-v1"); err != nil || decoded != "member@example.test" {
		t.Fatalf("round trip: %v", err)
	}
	b[len(b)-1] ^= 1
	if _, err := hostDecode(b, []string{"aes"}, "key-v1"); err == nil {
		t.Fatal("tampered AES ciphertext was accepted")
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

func TestHostAESReadsSharedFixedVector(t *testing.T) {
	got, err := hostDecode([]byte("4F524D2D414553320000112233445566778899AABB651DA9F08BE2FA7CD7B2DF5C04D91B32189DCD854A70762F99271A2BEBA64A248E24"), []string{"aes", "hex"}, "bench-salt")
	if err != nil || got != "user42@example.com" {
		t.Fatalf("fixed vector: %#v, %v", got, err)
	}
}

func TestHostAESDecodesByStoredVersion(t *testing.T) {
	oldValue, err := HostEncode("old@example.test", []string{"aes"}, "old-key")
	if err != nil {
		t.Fatal(err)
	}
	keyring, err := NewAESKeyring(map[int32]string{1: "old-key", 2: "new-key"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := HostDecodeVersioned(oldValue, []string{"aes"}, 1, keyring)
	if err != nil || decoded != "old@example.test" {
		t.Fatalf("versioned decode = %#v, %v", decoded, err)
	}
	if _, err := HostDecodeVersioned(oldValue, []string{"aes"}, 2, keyring); err == nil {
		t.Fatal("wrong stored version was accepted")
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
