package orm

import "testing"

func TestRotateAESRowUpdatesAllAESColumnsAndVersion(t *testing.T) {
	keys, err := NewAESKeyring(map[int32]string{1: "old", 2: "new"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	email, err := HostEncode("email@example.test", []string{"aes", "hex"}, "old")
	if err != nil {
		t.Fatal(err)
	}
	phone, err := HostEncode("01012345678", []string{"aes", "hex"}, "old")
	if err != nil {
		t.Fatal(err)
	}
	row := map[string]any{"seq": int64(7), "aes_key_version": int32(1), "aes_hex_email": email, "aes_hex_phone": phone}
	rotated, err := RotateAESRow(row, "aes_key_version", []AESRotationColumn{
		{Name: "aes_hex_email", Styles: []string{"aes", "hex"}},
		{Name: "aes_hex_phone", Styles: []string{"aes", "hex"}},
	}, 2, keys)
	if err != nil {
		t.Fatal(err)
	}
	if rotated["aes_key_version"] != int32(2) {
		t.Fatalf("version = %#v", rotated["aes_key_version"])
	}
	for _, c := range []struct{ name, plain string }{
		{"aes_hex_email", "email@example.test"}, {"aes_hex_phone", "01012345678"},
	} {
		decoded, err := hostDecode(rotated[c.name], []string{"aes", "hex"}, "new")
		if err != nil || decoded != c.plain {
			t.Fatalf("%s = %q, %v", c.name, decoded, err)
		}
	}
	if row["aes_hex_email"].(string) == rotated["aes_hex_email"].(string) {
		t.Fatal("email was not re-encrypted")
	}
	if row["aes_hex_phone"].(string) == rotated["aes_hex_phone"].(string) {
		t.Fatal("phone was not re-encrypted")
	}
}

func TestRotateAESRowDoesNotReturnPartialResult(t *testing.T) {
	keys, err := NewAESKeyring(map[int32]string{1: "old", 2: "new"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	row := map[string]any{"aes_key_version": int32(1), "aes_hex_email": "not-hex"}
	if _, err := RotateAESRow(row, "aes_key_version", []AESRotationColumn{{Name: "aes_hex_email", Styles: []string{"aes", "hex"}}}, 2, keys); err == nil {
		t.Fatal("invalid ciphertext was accepted")
	}
	if row["aes_key_version"] != int32(1) {
		t.Fatal("input row was changed")
	}
}
