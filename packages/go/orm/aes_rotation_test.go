package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

func TestRotateAESRowUpdatesAllAESColumnsAndVersion(t *testing.T) {
	// The test of COD-8 (docs/spec).
	testcase.Start(t, testcase.Compute)
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
		decoded, err := HostDecode(rotated[c.name], []string{"aes", "hex"}, "new")
		if err != nil || decoded != c.plain {
			t.Fatalf("%s = %q, %v", c.name, decoded, err)
		}
	}
	if as[string](t, row["aes_hex_email"]) == as[string](t, rotated["aes_hex_email"]) {
		t.Fatal("email was not re-encrypted")
	}
	if as[string](t, row["aes_hex_phone"]) == as[string](t, rotated["aes_hex_phone"]) {
		t.Fatal("phone was not re-encrypted")
	}
}

func TestRotateAESRowDoesNotReturnPartialResult(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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

// Requirements: COD-44.
func TestAESVersionCodesAreTheSameInEveryClient(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	keys, err := NewAESKeyring(map[int32]string{1: "old", 2: "new"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	cols := []AESRotationColumn{{Name: "aes_hex_email", Styles: []string{"aes", "hex"}}}
	row := func(version any) map[string]any {
		return map[string]any{"aes_key_version": version, "aes_hex_email": "00"}
	}
	cases := []struct {
		name string
		err  func() error
		code string
	}{
		{"undeclared stored version", func() error { _, err := RotateAESRow(row(int32(9)), "aes_key_version", cols, 2, keys); return err }, CodeConfig},
		{"undeclared read version", func() error { _, err := HostDecodeVersioned("00", []string{"aes"}, 9, keys); return err }, CodeConfig},
		{"empty key", func() error { _, err := NewAESKeyring(map[int32]string{1: ""}, 1); return err }, CodeConfig},
		{"current version undeclared", func() error { _, err := NewAESKeyring(map[int32]string{1: "k"}, 2); return err }, CodeConfig},
		{"stored version not an integer", func() error { _, err := RotateAESRow(row("abc"), "aes_key_version", cols, 2, keys); return err }, CodeCodecDecode},
		{"stored version zero", func() error { _, err := RotateAESRow(row(int64(0)), "aes_key_version", cols, 2, keys); return err }, CodeCodecDecode},
		{"stored version above i32", func() error { _, err := RotateAESRow(row(int64(1)<<31), "aes_key_version", cols, 2, keys); return err }, CodeCodecDecode},
		{"read version not an integer", func() error { _, err := rowVersion("1x"); return err }, CodeCodecDecode},
		{"read version above i32", func() error { _, err := rowVersion(uint64(1) << 31); return err }, CodeCodecDecode},
		{"AES column missing from rotation row", func() error {
			r := row(int32(1))
			delete(r, "aes_hex_email")
			_, err := RotateAESRow(r, "aes_key_version", cols, 2, keys)
			return err
		}, CodeInternal},
		{"version column missing from rotation row", func() error {
			r := row(int32(1))
			delete(r, "aes_key_version")
			_, err := RotateAESRow(r, "aes_key_version", cols, 2, keys)
			return err
		}, CodeInternal},
	}
	for _, c := range cases {
		if got := ErrorCode(c.err()); got != c.code {
			t.Errorf("%s: code = %q, want %s", c.name, got, c.code)
		}
	}
}
